// Shared helpers for RAIVI pages.
const STATUSES = ["Received", "Routed", "In Progress", "Resolved"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function statusBadge(status) {
  return el("span", "badge badge-" + status.toLowerCase().replace(/\s+/g, "-"), status);
}

function renderProgress(status) {
  const idx = STATUSES.indexOf(status);
  const wrap = el("div", "progress");
  STATUSES.forEach((s, i) => {
    const step = el("div", "progress-step" + (i <= idx ? " done" : ""));
    step.append(el("div", "dot"), el("div", "progress-label", s));
    wrap.append(step);
  });
  return wrap;
}

function addMeta(dl, label, value) {
  dl.append(el("dt", "", label), el("dd", "", value));
}

// Full view of one complaint: ID, status, progress, details, photo and history.
function renderReport(report) {
  const wrap = el("div", "report");

  const head = el("div", "report-head");
  head.append(el("div", "report-id-small", report.id), statusBadge(report.status));
  wrap.append(head, renderProgress(report.status));

  const meta = el("dl", "meta");
  addMeta(meta, "Category", report.category);
  addMeta(meta, "Department", report.department);
  addMeta(meta, "Submitted", formatTime(report.created_at));
  addMeta(meta, "Last update", formatTime(report.updated_at));
  wrap.append(meta);

  wrap.append(el("div", "field-label", "Complaint (from voice)"));
  wrap.append(el("div", "transcript-box", report.transcript));

  if (report.photo_url) {
    const img = el("img", "preview");
    img.src = report.photo_url;
    img.alt = "Photo attached to the complaint";
    wrap.append(img);
  }

  if (report.history && report.history.length) {
    wrap.append(el("div", "field-label", "History"));
    const list = el("ul", "history");
    report.history.forEach((h) => {
      const li = el("li");
      li.append(el("strong", "", h.status), el("span", "muted small", "  " + formatTime(h.at)));
      if (h.note) li.append(el("div", "small", h.note));
      list.append(li);
    });
    wrap.append(list);
  }
  return wrap;
}

// Decode the browser recording and convert it to 16-bit mono WAV (the format the API accepts)
function encodeWav(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / audioBuffer.numberOfChannels;
  }
  const byteLength = 44 + length * 2;
  const view = new DataView(new ArrayBuffer(byteLength));
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF"); view.setUint32(4, byteLength - 8, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

async function recordingToWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    return encodeWav(audioBuffer);
  } finally {
    ctx.close();
  }
}

// Speak a short confirmation. Failure is silent: the report is already saved.
async function speakText(text) {
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const audio = new Audio(URL.createObjectURL(await res.blob()));
    audio.play();
  } catch {
    // Optional audio
  }
}
