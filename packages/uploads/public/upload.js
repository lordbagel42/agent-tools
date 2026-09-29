const secret = location.hash.slice(1);
const id = location.pathname.split("/").pop();
history.replaceState(null, "", location.pathname);
// Reopening the complete link in the same tab can be a fragment-only navigation.
window.addEventListener("hashchange", () => {
  if (location.hash) location.reload();
});

const form = document.getElementById("upload-form");
const fields = document.getElementById("fields");
const fileInput = document.getElementById("file");
const send = document.getElementById("send");
const status = document.getElementById("status");
const progress = document.getElementById("progress");
let maxBytes = 0;

function message(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

function unavailable(text) {
  form.hidden = true;
  document.getElementById("heading").textContent = "Link unavailable";
  document.getElementById("intro").textContent =
    "Ask the sender for a new upload link.";
  message(text, "error");
}

async function initialize() {
  if (!/^[a-f0-9]{64}$/.test(secret) || !/^[a-f0-9-]{36}$/.test(id)) {
    unavailable(
      "Open the complete link you were sent. For your privacy, refreshing this page requires reopening that original link.",
    );
    return;
  }
  try {
    const response = await fetch(`/api/uploads/${id}/info`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    const data = await response.json();
    if (!response.ok) {
      unavailable(data.error || "This link has expired or was already used.");
      return;
    }
    maxBytes = data.maxBytes;
    document.getElementById("size-limit").textContent =
      maxBytes < 1048576
        ? `${maxBytes.toLocaleString()} ${maxBytes === 1 ? "byte" : "bytes"}`
        : `${(maxBytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
    const minutes = data.retentionSeconds / 60;
    const duration = minutes >= 60 ? minutes / 60 : minutes;
    const unit = minutes >= 60 ? "hour" : "minute";
    document.getElementById("retention").textContent =
      `${duration.toLocaleString()} ${unit}${duration === 1 ? "" : "s"}`;
    document.getElementById("link-expiry").textContent =
      `Retention starts when your upload completes. Unused link expires ${new Date(data.linkExpiresAt).toLocaleString()}.`;
    form.hidden = false;
    message("");
  } catch {
    unavailable(
      "Could not check this link. Check your connection and reopen the original link to try again.",
    );
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  send.disabled = !file || file.size > maxBytes;
  message(
    file && file.size > maxBytes
      ? "This file exceeds the link’s size limit. Choose a smaller file."
      : "",
    "error",
  );
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || file.size > maxBytes || fields.disabled) return;
  fields.disabled = true;
  form.setAttribute("aria-busy", "true");
  progress.hidden = false;
  progress.value = 0;
  send.textContent = "Uploading…";
  message("Keep this page open until your upload is confirmed.");

  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `/api/uploads/${id}/content`);
  xhr.timeout = 305000;
  xhr.setRequestHeader("authorization", `Bearer ${secret}`);
  xhr.setRequestHeader("content-type", "application/octet-stream");
  xhr.setRequestHeader("x-upload-filename", encodeURIComponent(file.name));
  xhr.upload.addEventListener("progress", (update) => {
    if (update.lengthComputable)
      progress.value = (update.loaded / update.total) * 100;
  });
  const restore = () => {
    fields.disabled = false;
    form.setAttribute("aria-busy", "false");
    progress.hidden = true;
    send.textContent = "Upload file";
  };
  xhr.addEventListener("load", () => {
    restore();
    let data;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      message(
        "The server could not confirm the upload. Try again or ask for a new link.",
        "error",
      );
      return;
    }
    if (xhr.status === 201) {
      form.hidden = true;
      document.getElementById("heading").textContent = "File received";
      document.getElementById("intro").textContent =
        "Your upload is complete. You can close this page.";
      message(
        `The file is available to the recipient until ${new Date(data.expiresAt).toLocaleString()}. This upload link cannot be used again.`,
        "success",
      );
    } else if ([404, 409, 410].includes(xhr.status)) {
      unavailable(data.error);
    } else {
      message(
        data.error || "Upload failed. Try again or ask for a new link.",
        "error",
      );
    }
  });
  for (const eventName of ["error", "timeout", "abort"]) {
    xhr.addEventListener(eventName, () => {
      restore();
      message(
        "The connection was interrupted. Try again; if this link is no longer available, ask the sender for a new one.",
        "error",
      );
    });
  }
  xhr.send(file);
});

void initialize();
