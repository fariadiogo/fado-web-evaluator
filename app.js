// Listening study page (LISTENING_STUDY.md §3). Plain JS, no dependencies.
// Flow: welcome/consent -> profile -> volume -> instructions -> 6 rating pages (the rater's list,
// random order) -> closing questions -> thanks. Answers are sent page by page to the
// endpoint in config.js (a Google Apps Script web app); progress is kept in localStorage so a
// reload resumes where the rater stopped.
(function () {
  "use strict";

  const CFG = window.STUDY_CONFIG || {};
  const STATE_KEY = "fado-listening-state-v5";   // v5: no shared page (a saved v4 state would
  const QUEUE_KEY = "fado-listening-queue-v5";    // point to clips that no longer exist)
  const params = new URLSearchParams(location.search);
  const MODE = ["pilot", "test"].includes(params.get("mode")) ? params.get("mode") : "live";
  const FORCED_LIST = ["A", "B"].includes(params.get("list")) ? params.get("list") : null;
  const LETTERS = "ABCDE";

  let app = document.getElementById("app");
  const progressEl = document.getElementById("progress");
  const statusEl = document.getElementById("status");

  const QUESTIONS = [
    { key: "fado", legend: "Até que ponto isto soa a fado?",
      hint: "Pense no género, não na qualidade da gravação.",
      options: [[1, "Nada"], [2, "Pouco"], [3, "Moderadamente"], [4, "Bastante"], [5, "Completamente"]] },
    { key: "voice", legend: "Até que ponto a voz soa a fado?",
      hint: "Pense só na forma de cantar, não no acompanhamento.",
      options: [[1, "Nada"], [2, "Pouco"], [3, "Moderadamente"], [4, "Bastante"], [5, "Completamente"]] },
    { key: "intel", legend: "Consegue perceber as palavras cantadas?",
      hint: "Se não houver voz, ou se não perceber nenhuma palavra, escolha «Nenhuma».",
      options: [[1, "Nenhuma"], [2, "Poucas"], [3, "Algumas"], [4, "A maioria"], [5, "Todas"]] },
    { key: "quality", legend: "Qualidade geral, enquanto música",
      hint: "",
      options: [[1, "Má"], [2, "Fraca"], [3, "Razoável"], [4, "Boa"], [5, "Excelente"]] },
    { key: "lang", legend: "Em que língua é cantada a letra?",
      hint: "Se não houver voz, ou se não conseguir perceber, escolha «Não consigo dizer».",
      options: [["pt-PT", "Português de Portugal"], ["pt-BR", "Português do Brasil"],
                ["outra", "Outra língua"], ["nao_sei", "Não consigo dizer"]] },
  ];

  let STIM = null;          // stimuli.json
  let S = null;             // rater state, persisted
  let players = [];         // audio elements of the current screen

  // ---------------------------------------------------------------- storage
  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function save() { writeJSON(STATE_KEY, S); }

  // ---------------------------------------------------------------- helpers
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }
  function fmt(t) {
    if (!isFinite(t)) t = 0;
    const s = Math.floor(t);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function stopAudio() {
    players.forEach(a => { a.pause(); a.removeAttribute("src"); a.load(); });
    players = [];
  }
  function setStatus(text) { statusEl.textContent = text || ""; }
  function radios(name, options, layout, checked) {
    return `<div class="options ${layout}" role="radiogroup">` + options.map(([v, label]) =>
      `<label class="opt"><input type="radio" name="${name}" value="${v}"${String(checked) === String(v) ? " checked" : ""}>` +
      `<span>${label}</span></label>`).join("") + `</div>`;
  }
  function scale5(name, options, checked) {
    return `<div class="options n5" role="radiogroup">` + options.map(([v, label]) =>
      `<label class="opt"><input type="radio" name="${name}" value="${v}"${String(checked) === String(v) ? " checked" : ""}>` +
      `<span><b>${v}</b>${label}</span></label>`).join("") + `</div>`;
  }
  function value(name) {
    const x = app.querySelector(`input[name="${name}"]:checked`);
    return x ? x.value : null;
  }
  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, Object.assign({ signal: ctrl.signal }, options)); }
    finally { clearTimeout(timer); }
  }

  // ---------------------------------------------------------------- sending
  // Every payload has a uid; the Apps Script ignores a uid it has already stored, so a retry
  // never duplicates rows.
  let flushing = false;
  function send(type, data) {
    const payload = Object.assign({
      type, session: S.session, mode: S.mode, list: S.list, sent: new Date().toISOString(),
    }, data);
    const queue = readJSON(QUEUE_KEY) || [];
    queue.push(payload);
    writeJSON(QUEUE_KEY, queue);
    flush();
  }
  async function post(payload) {
    const body = JSON.stringify(payload);
    if (!CFG.endpoint) {
      console.log("[offline mode] would send:", payload);
      (window.__sent = window.__sent || []).push(payload);
      return true;
    }
    const headers = { "Content-Type": "text/plain;charset=utf-8" };
    // keepalive lets the request finish if the tab is closed meanwhile (browsers cap it at 64 KB)
    const keepalive = body.length < 60000;
    try {
      const r = await fetchWithTimeout(CFG.endpoint, { method: "POST", headers, body, keepalive }, 20000);
      if (!r.ok) return false;
      // Only an explicit {ok: true} counts as stored: an Apps Script crash answers 200 with an
      // HTML page, which must be retried, not dropped. The endpoint allows CORS, so it is readable.
      const j = await r.json();
      return j.ok === true;
    } catch (e) {
      return false;
    }
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    let queue = readJSON(QUEUE_KEY) || [];
    while (queue.length) {
      const ok = await post(queue[0]);
      if (!ok) {
        setStatus("Sem ligação ao servidor: as respostas ficam guardadas neste navegador e serão enviadas assim que possível.");
        const note = app.querySelector("#sending");
        if (note) note.textContent = "Sem ligação ao servidor. As suas respostas estão guardadas neste " +
          "navegador e o envio é repetido automaticamente; por favor não feche a página.";
        flushing = false;
        setTimeout(flush, 8000);
        return;
      }
      queue = readJSON(QUEUE_KEY) || [];
      queue.shift();
      writeJSON(QUEUE_KEY, queue);
    }
    flushing = false;
    setStatus("");
    if (S && S.step === "closing" && S.finishing) go("done");
  }

  async function assignList() {
    if (FORCED_LIST) return FORCED_LIST;
    if (CFG.endpoint) {
      try {
        const r = await fetchWithTimeout(`${CFG.endpoint}?action=assign&mode=${S.mode}`, {}, 10000);
        const j = await r.json();
        if (j.list === "A" || j.list === "B") return j.list;
      } catch (e) { /* fall back to a random list */ }
    }
    return Math.random() < 0.5 ? "A" : "B";
  }

  function buildPages(list) {
    return shuffle(STIM.lists[list])
      .map(p => ({ kind: "rating", page: p.page, clips: shuffle(p.clips), repeat: false }));
  }

  // ---------------------------------------------------------------- screens
  function render() {
    stopAudio();
    // a fresh <main> per screen, so listeners of the previous screen do not linger
    const fresh = app.cloneNode(false);
    app.parentNode.replaceChild(fresh, app);
    app = fresh;
    const screens = { welcome, profile, volume, instructions, page, closing, done };
    (screens[S.step] || welcome)();
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }
  function go(step) { S.step = step; save(); render(); }

  function welcome() {
    progressEl.textContent = "";
    const contact = CFG.contactEmail
      ? `<p>Para qualquer questão, contacte <a href="mailto:${CFG.contactEmail}">${CFG.contactEmail}</a>.</p>` : "";
    app.innerHTML = `
      <h1>Estudo de audição sobre fado</h1>
      <p>Este estudo faz parte da dissertação de mestrado de
      ${CFG.researcher || ""} (${CFG.institution || ""}), sobre a geração automática de fado por computador.</p>
      <div class="card">
        <p><b>O que vai fazer.</b> Ouvir excertos de fado com cerca de 20 segundos e responder a cinco perguntas curtas
        sobre cada um. Alguns excertos são gravações reais; outros foram gerados por computador.</p>
        <p><b>Duração.</b> Cerca de ${CFG.minutes || 20} minutos, de seguida.</p>
        <p><b>Do que precisa.</b> Pedimos-lhe que use auscultadores ou auriculares; se não os tiver consigo, pode ouvir
        pelas colunas, desde que esteja num local silencioso. De preferência, use uma ligação Wi-Fi
        (são cerca de ${CFG.audioMB || 150} MB de áudio). Funciona no computador e no telemóvel.</p>
        <p><b>Anonimato.</b> Não pedimos nome, e-mail nem outros dados que o identifiquem. As respostas são usadas
        apenas para fins de investigação, nesta dissertação.</p>
        <p><b>Participação voluntária.</b> Pode desistir a qualquer momento, fechando a página; as respostas de
        participações incompletas não são analisadas.</p>
      </div>
      ${contact}
      <label class="check"><input type="checkbox" id="consent">
        <span>Tenho 18 anos ou mais, li a informação acima e aceito participar.</span></label>
      <div class="actions"><button class="btn" id="start" disabled>Começar</button></div>`;
    const box = app.querySelector("#consent"), btn = app.querySelector("#start");
    box.addEventListener("change", () => { btn.disabled = !box.checked; });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Um momento…";
      S = { session: uuid(), mode: MODE, list: null, started: new Date().toISOString(),
            startedMs: Date.now(), step: "profile", pages: null, pageIdx: 0, answers: {} };
      S.list = await assignList();
      S.pages = buildPages(S.list);
      go("profile");
    });
  }

  function profile() {
    progressEl.textContent = "";
    const P = S.profile || {};
    app.innerHTML = `
      <h1>Sobre si</h1>
      <p class="muted">Estas perguntas ajudam a interpretar as respostas. Todas são obrigatórias.</p>
      <div class="field"><span class="label">Idade</span>
        <select name="age"><option value="">Escolha…</option>
        ${["18-24", "25-34", "35-44", "45-54", "55-64", "65+"].map(v =>
          `<option value="${v}"${P.age === v ? " selected" : ""}>${v.replace("-", " a ").replace("65+", "65 ou mais")}</option>`).join("")}
        </select></div>
      <div class="field"><span class="label">Qual é a sua familiaridade com o fado?</span>
        <span class="hint">1 = nunca ouço fado; 5 = ouço com frequência e conheço bem o género.</span>
        ${scale5("familiarity", [[1, "Nenhuma"], [2, "Pouca"], [3, "Alguma"], [4, "Bastante"], [5, "Muita"]], P.familiarity)}</div>
      <div class="field"><span class="label">Formação musical</span>
        ${radios("training", [["none", "Nenhuma"], ["lt5", "Menos de 5 anos"], ["ge5", "5 anos ou mais"]], "list", P.training)}</div>
      <div class="field"><span class="label">Canta ou toca fado, mesmo que de forma amadora?</span>
        ${radios("plays_fado", [["sim", "Sim"], ["nao", "Não"]], "n2", P.plays_fado)}</div>
      <div class="field"><span class="label">Como vai ouvir os excertos?</span>
        ${radios("device", [["headphones", "Auscultadores (por cima ou à volta das orelhas)"],
          ["earphones", "Auriculares (dentro do ouvido)"],
          ["speakers", "Colunas do computador, do telemóvel ou outras"]], "list", P.device)}</div>
      <p class="warn" id="speakers" hidden>Pedimos que use auscultadores ou auriculares: com eles, as diferenças entre os
        excertos ouvem-se melhor. Se puder, ligue-os e altere a resposta acima. Se não, pode continuar com as colunas,
        desde que esteja num local silencioso.</p>
      <div class="actions"><button class="btn" id="next" disabled>Continuar</button></div>`;
    const btn = app.querySelector("#next"), warn = app.querySelector("#speakers");
    const read = () => ({
      age: app.querySelector('select[name="age"]').value || null,
      familiarity: value("familiarity"), training: value("training"),
      plays_fado: value("plays_fado"), device: value("device"),
    });
    const check = () => {
      const p = read();
      S.profile = p; save();
      warn.hidden = p.device !== "speakers";
      btn.disabled = Object.values(p).some(v => !v);
    };
    app.addEventListener("change", check);
    check();
    btn.addEventListener("click", () => {
      send("session", Object.assign({
        uid: `${S.session}-session`, started: S.started,
        user_agent: navigator.userAgent, screen: `${screen.width}x${screen.height}`,
      }, S.profile));
      go("volume");
    });
  }

  function playerCard(clipId, label, opts) {
    // opts: { played, onEnded, onPlay }
    const card = el(`
      <div class="clip-head">
        ${label ? `<span class="clip-label" aria-hidden="true">${label}</span>` : ""}
        <button class="btn play" type="button">▶ Ouvir</button>
        <div class="meter"><div class="bar"><div class="fill"></div></div><span class="time">0:00</span></div>
      </div>`);
    const audio = new Audio(`audio/${clipId}.wav`);
    audio.preload = "auto";
    players.push(audio);
    const btn = card.querySelector(".play"), bar = card.querySelector(".bar"),
          fill = card.querySelector(".fill"), time = card.querySelector(".time");
    let played = !!opts.played;
    const label_ = () => {
      if (!audio.paused) btn.textContent = "❚❚ Pausa";
      else if (audio.currentTime > 0 && !audio.ended) btn.textContent = "▶ Continuar";
      else btn.textContent = played ? "▶ Ouvir de novo" : "▶ Ouvir";
      btn.setAttribute("aria-label", `${btn.textContent.slice(2)}${label ? " excerto " + label : ""}`);
    };
    const tick = () => {
      const d = audio.duration || 0;
      fill.style.width = d ? `${Math.min(100, 100 * audio.currentTime / d)}%` : "0";
      time.textContent = d ? `${fmt(audio.currentTime)} / ${fmt(d)}` : "0:00";
    };
    const seekable = () => bar.classList.toggle("seekable", played);
    btn.addEventListener("click", () => {
      if (audio.paused) {
        players.forEach(a => { if (a !== audio) a.pause(); });
        if (audio.ended || audio.currentTime >= (audio.duration || Infinity)) audio.currentTime = 0;
        if (audio.currentTime === 0 && opts.onPlay) opts.onPlay();
        audio.play().catch(() => setStatus("Não foi possível reproduzir o áudio. Tente de novo."));
      } else {
        audio.pause();
      }
    });
    bar.addEventListener("click", ev => {       // seeking only after one full listen
      if (!played || !audio.duration) return;
      const r = bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * audio.duration;
      tick();
    });
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("loadedmetadata", tick);
    audio.addEventListener("play", label_);
    audio.addEventListener("playing", label_);
    audio.addEventListener("waiting", () => { if (!audio.paused) btn.textContent = "A carregar…"; });
    audio.addEventListener("pause", label_);
    audio.addEventListener("ended", () => {
      played = true; seekable(); label_(); tick();
      if (opts.onEnded) opts.onEnded();
    });
    audio.addEventListener("error", () =>
      setStatus("Não foi possível carregar um dos excertos. Verifique a ligação e recarregue a página."));
    label_(); seekable();
    return card;
  }

  function volume() {
    progressEl.textContent = "";
    app.innerHTML = `
      <h1>Volume</h1>
      <p>${(S.profile || {}).device === "speakers" ? "" : "Coloque os auscultadores ou auriculares. "}Carregue em «Ouvir» e ajuste o volume do seu dispositivo para um nível
      confortável. <b>Depois disso, não altere o volume até ao fim do estudo.</b></p>
      <div class="card" id="player"></div>
      <label class="check"><input type="checkbox" id="ok"><span>Ajustei o volume.</span></label>
      <div class="actions"><button class="btn" id="next" disabled>Continuar</button></div>`;
    app.querySelector("#player").appendChild(playerCard("calibration", "", { played: false }));
    const box = app.querySelector("#ok"), btn = app.querySelector("#next");
    box.addEventListener("change", () => { btn.disabled = !box.checked; });
    btn.addEventListener("click", () => go("instructions"));
  }

  function instructions() {
    progressEl.textContent = "";
    const n = S.pages.length;
    app.innerHTML = `
      <h1>Como funciona</h1>
      <p>Cada página corresponde a uma canção e tem cinco excertos, de A a E. Alguns podem ser gravações reais e outros
      gerados por computador; a ordem é aleatória e muda de página para página.</p>
      <p>Ouça cada excerto <b>até ao fim</b>: só depois pode responder. Pode voltar a ouvi-los as vezes que quiser e
      compará-los entre si antes de responder.</p>
      <div class="card">
        <p><b>Para cada excerto, responda a cinco perguntas:</b></p>
        <ol>
          <li><b>Até que ponto isto soa a fado?</b> Pense no género, não na qualidade da gravação.</li>
          <li><b>Até que ponto a voz soa a fado?</b> Pense só na forma de cantar, não no acompanhamento.</li>
          <li><b>Consegue perceber as palavras cantadas?</b> Se não houver voz, ou se não perceber nenhuma palavra,
          escolha «Nenhuma».</li>
          <li><b>Qualidade geral, enquanto música:</b> a sua impressão global do excerto.</li>
          <li><b>Em que língua é cantada a letra?</b> Se não houver voz, ou se não conseguir perceber, escolha
          «Não consigo dizer».</li>
        </ol>
      </div>
      <p>Não há respostas certas nem erradas: interessa a sua opinião.</p>
      <p>São ${n} páginas. Em cada uma, ouça primeiro os cinco excertos e só depois responda: compará-los ajuda a
      usar a escala da mesma forma em todas as páginas.</p>
      <div class="actions"><button class="btn" id="next">Começar</button></div>`;
    app.querySelector("#next").addEventListener("click", () => { S.pageIdx = 0; go("page"); });
  }

  function page() {
    const idx = S.pageIdx, P = S.pages[idx], n = S.pages.length;
    const A = S.answers[idx] = S.answers[idx] ||
      { t0: Date.now(), played: {}, plays: {}, full: {}, r: {} };
    save();
    progressEl.textContent = `Página ${idx + 1} de ${n}`;
    app.innerHTML = `
      <h1>Página ${idx + 1} de ${n}</h1>
      <p class="muted">Ouça os cinco excertos até ao fim e responda às cinco perguntas de cada um.</p>
      <div id="clips"></div>
      <div class="actions"><button class="btn" id="next" disabled>${idx === n - 1 ? "Continuar" : "Seguinte"}</button>
        <span class="missing" id="missing"></span></div>`;
    const box = app.querySelector("#clips");
    P.clips.forEach((id, i) => {
      const L = LETTERS[i];
      A.r[id] = A.r[id] || {};
      const card = el(`<section class="card clip" aria-label="Excerto ${L}"></section>`);
      const fields = QUESTIONS.map(q => `
        <fieldset class="q" data-clip="${id}"${A.played[id] ? "" : " disabled"}>
          <legend>${q.legend}</legend>
          ${q.options.length === 5
            ? scale5(`${idx}-${id}-${q.key}`, q.options, A.r[id][q.key])
            : radios(`${idx}-${id}-${q.key}`, q.options, "n4", A.r[id][q.key])}
        </fieldset>`).join("");
      card.appendChild(playerCard(id, L, {
        played: A.played[id],
        onPlay: () => { A.plays[id] = (A.plays[id] || 0) + 1; save(); },
        onEnded: () => {
          A.played[id] = true;
          A.full[id] = (A.full[id] || 0) + 1;
          save();
          card.querySelectorAll("fieldset").forEach(f => { f.disabled = false; });
          const note = card.querySelector(".locked-note");
          if (note) note.remove();
          update();
        },
      }));
      card.insertAdjacentHTML("beforeend",
        (A.played[id] ? "" : `<p class="locked-note">Ouça até ao fim para responder.</p>`) + fields);
      box.appendChild(card);
    });
    box.addEventListener("change", ev => {
      const m = ev.target.name && ev.target.name.match(/^\d+-([0-9a-f]+)-(\w+)$/);
      if (!m) return;
      A.r[m[1]][m[2]] = ev.target.value;
      save();
      update();
    });
    const btn = app.querySelector("#next"), missing = app.querySelector("#missing");
    function update() {
      const notPlayed = P.clips.filter(id => !A.played[id]).map(id => LETTERS[P.clips.indexOf(id)]);
      const notAnswered = P.clips.filter(id => A.played[id] && QUESTIONS.some(q => !A.r[id][q.key]))
        .map(id => LETTERS[P.clips.indexOf(id)]);
      const parts = [];
      if (notPlayed.length) parts.push(`Falta ouvir até ao fim: ${notPlayed.join(", ")}.`);
      if (notAnswered.length) parts.push(`Falta responder: ${notAnswered.join(", ")}.`);
      missing.textContent = parts.join(" ");
      btn.disabled = parts.length > 0;
    }
    update();
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const seconds = Math.round((Date.now() - A.t0) / 1000);
      send("page", {
        uid: `${S.session}-p${idx}`, kind: P.kind, page: P.page, page_pos: idx, repeat: P.repeat,
        page_seconds: seconds,
        rows: P.clips.map((id, i) => Object.assign({
          uid: `${S.session}-p${idx}-${id}`, clip: id, label: LETTERS[i], clip_pos: i,
          plays: A.plays[id] || 0, full_plays: A.full[id] || 0,
        }, A.r[id])),
      });
      if (idx < n - 1) { S.pageIdx = idx + 1; go("page"); }
      else go("closing");
    });
  }

  function closing() {
    progressEl.textContent = "Quase no fim";
    const C = S.closing || {};
    app.innerHTML = `
      <h1>Para terminar</h1>
      <div class="field"><span class="label">Reconheceu alguma das canções que ouviu?</span>
        ${radios("recognized", [["sim", "Sim"], ["nao", "Não"]], "n2", C.recognized)}</div>
      <div class="field" id="which" hidden><span class="label">Quais? <span class="muted">(opcional)</span></span>
        <input type="text" name="recognized_which" value="${(C.recognized_which || "").replace(/"/g, "&quot;")}"></div>
      <div class="field"><span class="label">Na sua opinião, o que fez um excerto soar, ou não soar, a fado?
        <span class="muted">(opcional)</span></span>
        <textarea name="what_fado"></textarea></div>
      <div class="field"><span class="label">Comentários <span class="muted">(opcional)</span></span>
        <textarea name="comments"></textarea></div>
      <div class="actions"><button class="btn" id="next" disabled>Enviar</button></div>`;
    app.querySelector('textarea[name="what_fado"]').value = C.what_fado || "";
    app.querySelector('textarea[name="comments"]').value = C.comments || "";
    const btn = app.querySelector("#next"), which = app.querySelector("#which");
    const read = () => ({
      recognized: value("recognized"),
      recognized_which: app.querySelector('input[name="recognized_which"]').value.trim(),
      what_fado: app.querySelector('textarea[name="what_fado"]').value.trim(),
      comments: app.querySelector('textarea[name="comments"]').value.trim(),
    });
    const check = () => {
      S.closing = read(); save();
      which.hidden = S.closing.recognized !== "sim";
      btn.disabled = !S.closing.recognized;
    };
    check();
    if (S.finishing) {
      // Enviar was clicked: the button waits until flush() has every answer stored, then
      // flush() moves on to the thanks (the browser warns before the page is closed meanwhile)
      app.querySelectorAll("input, textarea").forEach(x => { x.disabled = true; });
      btn.disabled = true;
      btn.textContent = "A enviar…";
      app.querySelector(".actions").insertAdjacentHTML("afterend",
        `<p id="sending" class="muted">A guardar as suas respostas…</p>`);
      return;
    }
    app.addEventListener("input", check);
    app.addEventListener("change", check);
    btn.addEventListener("click", () => {
      S.finishing = true;
      save();
      send("finish", Object.assign({
        uid: `${S.session}-finish`, total_seconds: Math.round((Date.now() - S.startedMs) / 1000),
      }, S.closing));
      render();
    });
  }

  function done() {
    // reached only from flush(), once the server has confirmed every answer
    progressEl.textContent = "";
    app.innerHTML = `
      <h1>Obrigado pela sua participação!</h1>
      <p>As suas respostas foram guardadas. Já pode fechar esta página.</p>
      <p class="muted">Se quiser, partilhe o estudo com outras pessoas, mas não lhes conte o que
      ouviu: a opinião de cada pessoa deve ser independente.</p>`;
  }
  window.addEventListener("beforeunload", ev => {
    if ((readJSON(QUEUE_KEY) || []).length) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // ---------------------------------------------------------------- start
  async function main() {
    if (MODE !== "live" && params.get("reset") === "1") {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(QUEUE_KEY);
    }
    try {
      const r = await fetch("stimuli.json", { cache: "no-cache" });
      STIM = await r.json();
    } catch (e) {
      app.innerHTML = `<p class="warn">Não foi possível carregar o estudo. Verifique a ligação e recarregue a página.</p>`;
      return;
    }
    S = readJSON(STATE_KEY) || { step: "welcome" };
    if (S.step !== "welcome" && !S.session) S = { step: "welcome" };
    // a state saved by the previous version on its waiting screen: wait on the button instead
    if (S.step === "done" && (readJSON(QUEUE_KEY) || []).length) Object.assign(S, { step: "closing", finishing: true });
    render();
    flush();
  }
  main();
})();
