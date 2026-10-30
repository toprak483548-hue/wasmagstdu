const $ = id => document.getElementById(id);
let token = localStorage.getItem("mesaj_token") || "";
let me = null, chats = [], activeChat = null, socket = null, authMode = "login";
let typingTimer = null, searchTimer = null, groupTimer = null, replyTarget = null;
let selectedGroupUsers = new Map(), profileAvatarMediaId = null, statusGroups = [], statusGroupIndex = 0, statusItemIndex = 0;
let mediaUrlCache = new Map(), onlineUsers = new Set();
let recorder = null, recorderStream = null, recordingChunks = [], recording = false;
let pc = null, localStream = null, currentCall = null, incomingCall = null, pendingIce = [];
let config = { pushEnabled: false, rtcIceServers: [{ urls: "stun:stun.l.google.com:19302" }], endToEndEncryption: false };
let groupInfo = null, groupAddTimer = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function initials(value) { return String(value || "?").trim().slice(0, 1).toLocaleUpperCase("tr-TR"); }
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}
function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return fetch(path, { ...options, headers }).then(async response => {
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(data?.error || data || "Bir hata oluştu.");
    return data;
  });
}
async function mediaUrl(id) {
  if (!id) return null;
  if (mediaUrlCache.has(String(id))) return mediaUrlCache.get(String(id));
  const response = await fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const url = URL.createObjectURL(await response.blob());
  mediaUrlCache.set(String(id), url);
  return url;
}
function setAvatar(el, user, large = false) {
  if (!el) return;
  el.classList.add("avatar");
  if (large) el.classList.add("avatar-large");
  el.textContent = initials(user?.display_name || user?.displayName || user?.username);
  const match = user?.avatar_url || user?.avatarUrl;
  const id = match?.match(/\/api\/media\/(\d+)/)?.[1];
  if (id) mediaUrl(id).then(url => {
    if (url) { el.innerHTML = ""; const img = document.createElement("img"); img.src = url; img.alt = ""; el.appendChild(img); }
  }).catch(() => {});
}
function formatTime(date) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
}
function chatName(chat) {
  if (chat.is_group) return chat.title || "Grup";
  const user = (chat.members || [])[0];
  return user?.display_name || user?.username || "Sohbet";
}
function chatOtherUser(chat) { return (chat?.members || [])[0] || null; }
function showModal(id) {
  $("modalLayer").classList.remove("hidden");
  ["profileModal", "groupModal", "groupInfoModal", "chatActionsModal", "statusModal", "statusViewer"].forEach(x => $(x).classList.add("hidden"));
  $(id).classList.remove("hidden");
}
function closeModal(id) {
  $(id).classList.add("hidden");
  if (["profileModal", "groupModal", "groupInfoModal", "chatActionsModal", "statusModal", "statusViewer"].every(x => $(x).classList.contains("hidden"))) $("modalLayer").classList.add("hidden");
}
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => closeModal(button.dataset.close)));

// Authentication
$("authSwitch").onclick = () => {
  authMode = authMode === "login" ? "register" : "login";
  $("displayNameField").classList.toggle("hidden", authMode === "login");
  $("authSubmit").textContent = authMode === "login" ? "Giriş yap" : "Hesap oluştur";
  $("authSwitchText").textContent = authMode === "login" ? "Henüz hesabın yok mu?" : "Zaten hesabın var mı?";
  $("authSwitch").textContent = authMode === "login" ? "Hesap oluştur" : "Giriş yap";
  $("password").autocomplete = authMode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
};
$("authForm").onsubmit = async e => {
  e.preventDefault(); $("authError").textContent = ""; $("authSubmit").disabled = true;
  try {
    const payload = { username: $("username").value, password: $("password").value };
    if (authMode === "register") payload.displayName = $("displayName").value;
    const data = await api(`/api/${authMode}`, { method: "POST", body: JSON.stringify(payload) });
    token = data.token; localStorage.setItem("mesaj_token", token); await boot();
  } catch (err) { $("authError").textContent = err.message; }
  finally { $("authSubmit").disabled = false; }
};

// Theme and navigation
function setTheme(dark) {
  document.body.classList.toggle("dark", dark); localStorage.setItem("mesaj_dark", dark ? "1" : "0");
  $("settingsThemeBtn").classList.toggle("active", dark);
}
$("themeBtn").onclick = () => setTheme(!document.body.classList.contains("dark"));
$("settingsThemeBtn").onclick = () => setTheme(!document.body.classList.contains("dark"));
$("settingsBtn").onclick = () => openProfile();
$("myProfileBtn").onclick = () => openProfile();
$("logoutBtn").onclick = () => { if (socket) socket.disconnect(); localStorage.removeItem("mesaj_token"); token = ""; location.reload(); };
$("backBtn").onclick = () => $("appView").classList.remove("chat-open");
$("refreshChatsBtn").onclick = () => loadChats();
document.querySelectorAll(".side-tab").forEach(button => button.onclick = () => switchTab(button.dataset.tab));
let currentTab = "chats";
async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".side-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("chatList").innerHTML = "";
  if (tab === "updates") { $("listHeading").innerHTML = '<span>DURUMLAR</span><button id="addStatusBtn" type="button" title="Durum paylaş">＋</button>'; $("addStatusBtn").onclick = openStatus; await loadStatuses(); }
  else if (tab === "archived") { $("listHeading").innerHTML = '<span>ARŞİVLENEN SOHBETLER</span><button id="refreshArchiveBtn" type="button">↻</button>'; $("refreshArchiveBtn").onclick = loadChats; await loadChats(true); }
  else { $("listHeading").innerHTML = '<span>SON SOHBETLER</span><button id="refreshChatsBtn" type="button" title="Yenile">↻</button>'; $("refreshChatsBtn").onclick = loadChats; await loadChats(); }
}

// Chats
function renderChats() {
  const q = $("searchUsers").value.trim().toLocaleLowerCase("tr-TR");
  const filtered = chats.filter(c => !q || chatName(c).toLocaleLowerCase("tr-TR").includes(q) || (c.members || []).some(m => m.username.includes(q)));
  $("chatList").innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty-state"; empty.style.cssText = "padding:24px 15px;color:#96a49f;font-size:11px;text-align:center;line-height:1.6";
    empty.textContent = currentTab === "archived" ? "Arşivlenmiş sohbet yok." : "Henüz sohbet yok. Bir kullanıcı arayarak konuşma başlat."; $("chatList").appendChild(empty); return;
  }
  filtered.forEach(chat => {
    const item = document.createElement("div"); item.className = "chat-item" + (activeChat?.id === chat.id ? " selected" : "");
    const av = document.createElement("div"); av.className = "avatar"; setAvatar(av, chat.members?.[0] || { display_name: chatName(chat) });
    const info = document.createElement("div"); info.className = "chat-info";
    const top = document.createElement("div"); top.className = "chat-info-top";
    const name = document.createElement("b"); name.textContent = chatName(chat);
    const time = document.createElement("span"); time.className = "chat-time"; time.textContent = formatTime(chat.last_message_at);
    top.append(name, time);
    const preview = document.createElement("p");
    preview.textContent = chat.last_message || (chat.is_group ? "Grup oluşturuldu" : "Sohbeti başlat");
    const bottom = document.createElement("div"); bottom.className = "chat-info-top"; bottom.append(preview);
    if (Number(chat.unread_count) > 0) { const badge = document.createElement("span"); badge.className = "unread-count"; badge.textContent = chat.unread_count > 99 ? "99+" : chat.unread_count; bottom.append(badge); }
    info.append(top, bottom); item.append(av, info); item.onclick = () => openChat(chat); $("chatList").appendChild(item);
  });
}
async function loadChats(archived = currentTab === "archived") {
  try { chats = await api(`/api/chats${archived ? "?archived=1" : ""}`); renderChats(); }
  catch (e) { toast(e.message); }
}
function refreshChatsIfVisible() {
  if (currentTab === "chats" || currentTab === "archived") return loadChats();
}
async function openChat(chat) {
  activeChat = chat; replyTarget = null; updateReplyBar();
  $("welcome").classList.add("hidden"); $("chatView").classList.remove("hidden"); $("appView").classList.add("chat-open");
  $("chatTitle").textContent = chatName(chat); setAvatar($("chatAvatar"), chat.members?.[0] || { display_name: chatName(chat) });
  $("audioCallBtn").disabled = Boolean(chat.is_group); $("videoCallBtn").disabled = Boolean(chat.is_group);
  refreshChatSubtitle(); renderChats(); await loadMessages();
  markActiveChatRead();
}
function isActiveChatVisible() {
  return Boolean(
    activeChat &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    $("appView").classList.contains("chat-open") &&
    !$("chatView").classList.contains("hidden") &&
    $("modalLayer").classList.contains("hidden")
  );
}
async function markActiveChatRead() {
  if (!isActiveChatVisible()) return;
  const chatId = Number(activeChat.id);
  try {
    await api(`/api/chats/${chatId}/read`, { method: "POST", body: "{}" });
  } catch (error) {
    console.warn("Sohbet okundu bilgisi güncellenemedi:", error);
  }
}
function refreshChatSubtitle() {
  if (!activeChat) return;
  const other = chatOtherUser(activeChat);
  if (activeChat.is_group) $("chatSubtitle").textContent = `${(activeChat.members || []).length + 1} katılımcı`;
  else if (other && onlineUsers.has(Number(other.id))) $("chatSubtitle").textContent = "çevrimiçi";
  else $("chatSubtitle").textContent = other?.last_seen ? `son görülme ${formatTime(other.last_seen)}` : "Mesajlaşma";
}
async function loadMessages(query = "") {
  if (!activeChat) return;
  try {
    const requestedChatId = Number(activeChat.id);
    const msgs = await api(`/api/chats/${requestedChatId}/messages${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    if (!activeChat || Number(activeChat.id) !== requestedChatId) return;
    $("messages").innerHTML = "";
    msgs.forEach(m => addMessage(m, false));
    $("messages").scrollTop = $("messages").scrollHeight;
    if (currentTab === "chats" || currentTab === "archived") loadChats();
  } catch (e) { toast(e.message); }
}
function addMessage(m, scroll = true) {
  if (!activeChat || Number(m.chat_id) !== Number(activeChat.id) || $(`msg-${m.id}`)) return;
  const mine = Number(m.sender_id) === Number(me.id);
  const row = document.createElement("article"); row.className = `message-row${mine ? " mine" : ""}`; row.id = `msg-${m.id}`; row.dataset.createdAt = m.created_at || "";
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  if (!mine && activeChat.is_group) { const sender = document.createElement("div"); sender.className = "sender-name"; sender.textContent = m.display_name || m.username; bubble.appendChild(sender); }
  if (m.reply) { const reply = document.createElement("div"); reply.className = "reply-preview"; reply.textContent = `${m.reply.sender_name || "Yanıt"}: ${m.reply.body || ""}`; bubble.appendChild(reply); }
  if (m.deleted_at) {
    const text = document.createElement("div"); text.className = "message-text"; text.textContent = "Bu mesaj silindi"; text.style.fontStyle = "italic"; text.style.color = "#91a19b"; bubble.appendChild(text);
  } else {
    if (m.media_id) renderMessageMedia(bubble, m).catch(() => {});
    if (m.body) { const text = document.createElement("div"); text.className = "message-text"; text.textContent = m.body; bubble.appendChild(text); }
  }
  const meta = document.createElement("div"); meta.className = "message-meta";
  if (m.edited_at) { const edited = document.createElement("span"); edited.className = "edited-label"; edited.textContent = "düzenlendi"; meta.appendChild(edited); }
  const time = document.createElement("span"); time.textContent = formatTime(m.created_at); meta.appendChild(time);
  if (mine) { const isRead = Boolean(m.read_by_peer); const ticks = document.createElement("span"); ticks.className = "message-ticks" + (isRead ? " read" : ""); ticks.textContent = (m.delivered || isRead) ? "✓✓" : "✓"; meta.appendChild(ticks); }
  bubble.appendChild(meta); row.appendChild(bubble);
  if (m.reactions?.length) {
    const reactions = document.createElement("div"); reactions.className = "reaction-list";
    m.reactions.forEach(r => { const chip = document.createElement("button"); chip.className = "reaction-chip" + (r.mine ? " mine" : ""); chip.type = "button"; chip.textContent = `${r.emoji} ${r.count}`; chip.onclick = () => reactToMessage(m.id, r.emoji); reactions.appendChild(chip); });
    row.appendChild(reactions);
  }
  const actions = document.createElement("div"); actions.className = "message-actions";
  const action = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = fn; actions.appendChild(b); };
  action("↩ Yanıtla", () => { replyTarget = { id: Number(m.id), body: m.body || (m.message_type === "image" ? "Fotoğraf" : "Dosya") }; updateReplyBar(); $("messageInput").focus(); });
  action("❤", () => reactToMessage(m.id, "❤️"));
  if (mine && !m.deleted_at && m.message_type === "text") action("Düzenle", async () => {
    const next = prompt("Mesajı düzenle:", m.body); if (next === null || !next.trim()) return;
    try { await api(`/api/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ body: next.trim() }) }); await loadMessages(); } catch (e) { toast(e.message); }
  });
  if (mine && !m.deleted_at) action("Sil", async () => {
    if (!confirm("Bu mesajı herkes için silmek istiyor musun?")) return;
    try { await api(`/api/messages/${m.id}`, { method: "DELETE" }); await loadMessages(); } catch (e) { toast(e.message); }
  });
  row.appendChild(actions); $("messages").appendChild(row);
  if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}
async function renderMessageMedia(container, message) {
  const url = await mediaUrl(message.media_id); if (!url || !container.isConnected) return;
  if (message.message_type === "image") { const img = document.createElement("img"); img.className = "message-media"; img.src = url; img.alt = "Paylaşılan fotoğraf"; img.loading = "lazy"; img.onclick = () => window.open(url, "_blank", "noopener"); container.insertBefore(img, container.firstChild); }
  else if (message.message_type === "video") { const video = document.createElement("video"); video.className = "message-media"; video.src = url; video.controls = true; video.playsInline = true; container.insertBefore(video, container.firstChild); }
  else if (message.message_type === "audio") { const audio = document.createElement("audio"); audio.className = "message-media audio"; audio.src = url; audio.controls = true; container.insertBefore(audio, container.firstChild); }
  else { const wrap = document.createElement("div"); wrap.className = "file-attachment"; const icon = document.createElement("span"); icon.textContent = "▤"; const link = document.createElement("a"); link.href = url; link.download = message.file_name || "dosya"; link.textContent = message.file_name || "Dosyayı indir"; wrap.append(icon, link); container.insertBefore(wrap, container.firstChild); }
}
function updateReplyBar() {
  $("replyBar").classList.toggle("hidden", !replyTarget);
  if (replyTarget) $("replyText").textContent = String(replyTarget.body).slice(0, 110);
}
$("cancelReply").onclick = () => { replyTarget = null; updateReplyBar(); };

// Send text and files
$("sendForm").onsubmit = async e => {
  e.preventDefault(); if (!activeChat) return;
  const body = $("messageInput").value.trim(); if (!body) return;
  const payload = { body, type: "text", replyTo: replyTarget?.id || null };
  $("messageInput").value = ""; resizeComposer(); replyTarget = null; updateReplyBar();
  try { const m = await api(`/api/chats/${activeChat.id}/messages`, { method: "POST", body: JSON.stringify(payload) }); addMessage(m); refreshChatsIfVisible(); }
  catch (err) { $("messageInput").value = body; toast(err.message); }
};
$("messageInput").addEventListener("input", () => {
  resizeComposer(); if (!socket || !activeChat) return;
  socket.emit("typing", { chatId: activeChat.id, active: true }); clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", { chatId: activeChat.id, active: false }), 900);
});
function resizeComposer() { const el = $("messageInput"); el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; }
$("emojiBtn").onclick = () => { $("messageInput").value += " 😊"; $("messageInput").focus(); resizeComposer(); };
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = async () => { const file = $("fileInput").files[0]; if (file) await sendFile(file); $("fileInput").value = ""; };
async function uploadMedia(file, purpose = "message") {
  const form = new FormData(); form.append("file", file); form.append("purpose", purpose);
  return api("/api/media", { method: "POST", body: form });
}
async function sendFile(file, forcedType = null) {
  if (!activeChat) return;
  if (file.size > 8 * 1024 * 1024) return toast("Dosya en fazla 8 MB olabilir.");
  let type = forcedType || (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "file");
  try {
    toast("Dosya yükleniyor..."); const media = await uploadMedia(file, "message");
    const m = await api(`/api/chats/${activeChat.id}/messages`, { method: "POST", body: JSON.stringify({ body: "", type, mediaId: media.id, replyTo: replyTarget?.id || null }) });
    replyTarget = null; updateReplyBar(); addMessage(m); refreshChatsIfVisible();
  } catch (e) { toast(e.message); }
}

// Voice notes
$("voiceBtn").onclick = async () => {
  if (recording) { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Bu tarayıcı ses kaydını desteklemiyor.");
  try {
    recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = []; recorder = new MediaRecorder(recorderStream);
    recorder.ondataavailable = e => { if (e.data.size) recordingChunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(recordingChunks, { type: recorder.mimeType || "audio/webm" });
      recorderStream?.getTracks().forEach(t => t.stop()); recorderStream = null; recording = false;
      $("voiceBtn").classList.remove("recording"); $("voiceBtn").textContent = "🎙";
      if (blob.size) await sendFile(new File([blob], `sesli-mesaj-${Date.now()}.webm`, { type: blob.type }), "audio");
    };
    recorder.start(); recording = true; $("voiceBtn").classList.add("recording"); $("voiceBtn").textContent = "■"; toast("Kayıt başladı. Bitirmek için tekrar dokun.");
  } catch { toast("Mikrofon izni verilmedi."); }
};

// User search
$("searchUsers").oninput = () => {
  clearTimeout(searchTimer); const q = $("searchUsers").value.trim(); $("clearSearchBtn").classList.toggle("hidden", !q); renderChats();
  if (q.length < 2) { $("searchResults").classList.add("hidden"); return; }
  searchTimer = setTimeout(() => searchUsers(q), 250);
};
$("clearSearchBtn").onclick = () => { $("searchUsers").value = ""; $("clearSearchBtn").classList.add("hidden"); $("searchResults").classList.add("hidden"); renderChats(); };
async function searchUsers(q) {
  try {
    const users = await api(`/api/users?q=${encodeURIComponent(q)}`); const result = $("searchResults"); result.innerHTML = ""; result.classList.remove("hidden");
    if (!users.length) { const empty = document.createElement("div"); empty.style.cssText = "padding:14px;color:#98a6a0;font-size:11px"; empty.textContent = "Kullanıcı bulunamadı."; result.appendChild(empty); return; }
    users.forEach(user => {
      const row = document.createElement("div"); row.className = "user-result";
      const person = document.createElement("div"); person.className = "person"; const av = document.createElement("div"); av.className = "avatar"; setAvatar(av, user);
      const names = document.createElement("span"); const name = document.createElement("b"); name.textContent = user.display_name; const handle = document.createElement("small"); handle.textContent = `@${user.username}`; names.append(name, handle); person.append(av, names);
      const button = document.createElement("button"); button.textContent = "Sohbet"; button.onclick = async () => {
        try { const c = await api("/api/chats/direct", { method: "POST", body: JSON.stringify({ userId: user.id }) }); if (currentTab !== "chats") await switchTab("chats"); await loadChats(); let chat = chats.find(x => Number(x.id) === Number(c.id)); if (!chat) chat = { id: c.id, is_group: false, members: [user] }; await openChat(chat); result.classList.add("hidden"); $("searchUsers").value = ""; renderChats(); }
        catch (e) { toast(e.message); }
      };
      row.append(person, button); result.appendChild(row);
    });
  } catch (e) { toast(e.message); }
}

// Group creation
$("newGroupBtn").onclick = () => { selectedGroupUsers.clear(); $("groupName").value = ""; $("groupUserSearch").value = ""; $("groupUserResults").innerHTML = ""; renderSelectedGroup(); $("groupError").textContent = ""; showModal("groupModal"); };
$("groupUserSearch").oninput = () => { clearTimeout(groupTimer); const q = $("groupUserSearch").value.trim(); if (q.length < 2) { $("groupUserResults").innerHTML = ""; return; } groupTimer = setTimeout(async () => {
  try { const users = await api(`/api/users?q=${encodeURIComponent(q)}`); $("groupUserResults").innerHTML = ""; users.forEach(u => {
    const row = document.createElement("div"); row.className = "group-candidate"; const av = document.createElement("div"); av.className = "avatar"; av.style.width = "34px"; av.style.height = "34px"; setAvatar(av, u);
    const name = document.createElement("span"); name.textContent = `${u.display_name} · @${u.username}`; name.style.fontSize = "11px";
    const btn = document.createElement("button"); btn.textContent = selectedGroupUsers.has(u.id) ? "Çıkar" : "Ekle"; btn.onclick = () => { if (selectedGroupUsers.has(u.id)) selectedGroupUsers.delete(u.id); else selectedGroupUsers.set(u.id, u); btn.textContent = selectedGroupUsers.has(u.id) ? "Çıkar" : "Ekle"; renderSelectedGroup(); };
    row.append(av, name, btn); $("groupUserResults").appendChild(row);
  }); } catch (e) { toast(e.message); }
}, 250); };
function renderSelectedGroup() { $("groupSelected").innerHTML = ""; selectedGroupUsers.forEach(u => { const chip = document.createElement("span"); chip.className = "selected-user"; chip.textContent = u.display_name; $("groupSelected").appendChild(chip); }); $("groupCount").textContent = `${selectedGroupUsers.size} kişi seçildi`; }
$("groupForm").onsubmit = async e => { e.preventDefault(); $("groupError").textContent = ""; if (!selectedGroupUsers.size) { $("groupError").textContent = "En az bir katılımcı ekle."; return; }
  try { const c = await api("/api/chats/group", { method: "POST", body: JSON.stringify({ title: $("groupName").value, userIds: [...selectedGroupUsers.keys()] }) }); closeModal("groupModal"); if (currentTab !== "chats") await switchTab("chats"); await loadChats(); const chat = chats.find(x => Number(x.id) === Number(c.id)); if (chat) openChat(chat); toast("Grup oluşturuldu."); }
  catch (err) { $("groupError").textContent = err.message; }
};

// Profile and preferences
function openProfile() {
  profileAvatarMediaId = null; $("profileDisplayName").value = me.display_name; $("profileBio").value = me.bio || ""; setAvatar($("profilePreview"), me, true); $("profileError").textContent = "";
  $("settingsThemeBtn").classList.toggle("active", document.body.classList.contains("dark"));
  $("enablePushBtn").textContent = "Bildirim durumu kontrol ediliyor…";
  showModal("profileModal");
  refreshPushButtonState();
}
$("avatarInput").onchange = async () => {
  const file = $("avatarInput").files[0]; if (!file) return;
  try { const m = await uploadMedia(file, "avatar"); profileAvatarMediaId = m.id; const url = await mediaUrl(m.id); if (url) $("profilePreview").innerHTML = `<img src="${url}" alt="Profil fotoğrafı">`; }
  catch (e) { $("profileError").textContent = e.message; }
};
$("profileForm").onsubmit = async e => {
  e.preventDefault(); try {
    const data = await api("/api/me", { method: "PATCH", body: JSON.stringify({ displayName: $("profileDisplayName").value, bio: $("profileBio").value, avatarMediaId: profileAvatarMediaId }) });
    me = data; $("myName").textContent = me.display_name; $("myHandle").textContent = `@${me.username}`; setAvatar($("myAvatar"), me, true);
    closeModal("profileModal"); toast("Profil güncellendi."); refreshChatsIfVisible();
  } catch (e) { $("profileError").textContent = e.message; }
};
$("chatMenuBtn").onclick = async () => {
  if (!activeChat) return;
  if (activeChat.is_group) { await openGroupInfo(); return; }
  $("toggleMuteChatBtn").querySelector("span").textContent = activeChat.muted ? "Bildirimleri aç" : "Bildirimleri sessize al";
  $("archiveChatBtn").querySelector("span").textContent = currentTab === "archived" ? "Arşivden çıkar" : "Sohbeti arşivle";
  showModal("chatActionsModal");
};
$("toggleMuteChatBtn").onclick = async () => {
  if (!activeChat) return;
  try {
    const muted = !activeChat.muted;
    await api(`/api/chats/${activeChat.id}/preferences`, { method: "PATCH", body: JSON.stringify({ muted }) });
    activeChat.muted = muted; closeModal("chatActionsModal"); toast(muted ? "Bildirimler sessize alındı." : "Bildirimler açıldı.");
  } catch (e) { toast(e.message); }
};
$("archiveChatBtn").onclick = async () => {
  if (!activeChat) return;
  const wasArchived = currentTab === "archived";
  try {
    await api(`/api/chats/${activeChat.id}/preferences`, { method: "PATCH", body: JSON.stringify({ archived: !wasArchived }) });
    closeModal("chatActionsModal"); $("appView").classList.remove("chat-open"); $("chatView").classList.add("hidden"); $("welcome").classList.remove("hidden"); activeChat = null;
    await loadChats(wasArchived); toast(wasArchived ? "Sohbet arşivden çıkarıldı." : "Sohbet arşivlendi.");
  } catch (e) { toast(e.message); }
};

// Group management: administrators can rename groups and manage participants.
async function openGroupInfo() {
  if (!activeChat?.is_group) return;
  try {
    groupInfo = await api(`/api/chats/${activeChat.id}/members`);
    $("groupInfoName").value = groupInfo.title || "";
    $("groupInfoError").textContent = "";
    $("groupInfoCount").textContent = `${groupInfo.members.length} kişi`;
    $("groupAddArea").classList.toggle("hidden", !groupInfo.is_admin);
    $("groupInfoName").disabled = !groupInfo.is_admin;
    $("saveGroupInfoBtn").classList.toggle("hidden", !groupInfo.is_admin);
    $("groupAddSearch").value = ""; $("groupAddResults").innerHTML = "";
    $("groupMuteBtn").querySelector("span").textContent = activeChat.muted ? "Bildirimleri aç" : "Bildirimleri sessize al";
    $("groupArchiveBtn").querySelector("span").textContent = currentTab === "archived" ? "Arşivden çıkar" : "Sohbeti arşivle";
    renderGroupInfoMembers(); showModal("groupInfoModal");
  } catch (e) { toast(e.message); }
}
function renderGroupInfoMembers() {
  const target = $("groupInfoMembers"); target.innerHTML = "";
  if (!groupInfo) return;
  groupInfo.members.forEach(member => {
    const row = document.createElement("div"); row.className = "group-candidate";
    const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.style.width = "34px"; avatar.style.height = "34px"; setAvatar(avatar, member);
    const name = document.createElement("span"); name.textContent = `${member.display_name} · @${member.username}${member.role === "admin" ? " · Yönetici" : ""}`; name.style.fontSize = "11px";
    row.append(avatar, name);
    if (groupInfo.is_admin && member.role !== "admin" && Number(member.id) !== Number(me.id)) {
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Çıkar";
      remove.onclick = async () => {
        if (!confirm(`${member.display_name} gruptan çıkarılsın mı?`)) return;
        try { await api(`/api/chats/${activeChat.id}/members/${member.id}`, { method: "DELETE" }); await openGroupInfo(); await loadChats(); }
        catch (e) { $("groupInfoError").textContent = e.message; }
      };
      row.appendChild(remove);
    }
    target.appendChild(row);
  });
}
$("groupInfoForm").onsubmit = async e => {
  e.preventDefault(); if (!groupInfo?.is_admin || !activeChat) return;
  try {
    await api(`/api/chats/${activeChat.id}/group`, { method: "PATCH", body: JSON.stringify({ title: $("groupInfoName").value }) });
    activeChat.title = $("groupInfoName").value.trim(); $("chatTitle").textContent = activeChat.title;
    await loadChats(); await openGroupInfo(); toast("Grup bilgileri güncellendi.");
  } catch (err) { $("groupInfoError").textContent = err.message; }
};
$("groupAddSearch").oninput = () => {
  clearTimeout(groupAddTimer); const q = $("groupAddSearch").value.trim();
  if (q.length < 2) { $("groupAddResults").innerHTML = ""; return; }
  groupAddTimer = setTimeout(async () => {
    try {
      const users = await api(`/api/users?q=${encodeURIComponent(q)}`);
      $("groupAddResults").innerHTML = "";
      users.filter(u => !groupInfo.members.some(m => Number(m.id) === Number(u.id))).forEach(user => {
        const row = document.createElement("div"); row.className = "group-candidate";
        const name = document.createElement("span"); name.textContent = `${user.display_name} · @${user.username}`; name.style.fontSize = "11px";
        const add = document.createElement("button"); add.type = "button"; add.textContent = "Ekle";
        add.onclick = async () => {
          try { await api(`/api/chats/${activeChat.id}/members`, { method: "POST", body: JSON.stringify({ userId: user.id }) }); await openGroupInfo(); await loadChats(); toast(`${user.display_name} gruba eklendi.`); }
          catch (e) { $("groupInfoError").textContent = e.message; }
        };
        row.append(name, add); $("groupAddResults").appendChild(row);
      });
      if (!$("groupAddResults").children.length) { const empty = document.createElement("div"); empty.className = "muted-text"; empty.textContent = "Eklenecek yeni kullanıcı bulunamadı."; $("groupAddResults").appendChild(empty); }
    } catch (e) { $("groupInfoError").textContent = e.message; }
  }, 250);
};
$("groupMuteBtn").onclick = async () => {
  if (!activeChat) return;
  try {
    const muted = !activeChat.muted;
    await api(`/api/chats/${activeChat.id}/preferences`, { method: "PATCH", body: JSON.stringify({ muted }) });
    activeChat.muted = muted; closeModal("groupInfoModal"); toast(muted ? "Bildirimler sessize alındı." : "Bildirimler açıldı.");
  } catch (e) { $("groupInfoError").textContent = e.message; }
};
$("groupArchiveBtn").onclick = async () => {
  if (!activeChat) return;
  const wasArchived = currentTab === "archived";
  try {
    await api(`/api/chats/${activeChat.id}/preferences`, { method: "PATCH", body: JSON.stringify({ archived: !wasArchived }) });
    closeModal("groupInfoModal"); activeChat = null; $("appView").classList.remove("chat-open"); $("chatView").classList.add("hidden"); $("welcome").classList.remove("hidden");
    await loadChats(wasArchived); toast(wasArchived ? "Sohbet arşivden çıkarıldı." : "Sohbet arşivlendi.");
  } catch (e) { $("groupInfoError").textContent = e.message; }
};
$("leaveGroupBtn").onclick = async () => {
  if (!activeChat?.is_group || !confirm("Bu gruptan ayrılmak istiyor musun?")) return;
  try {
    await api(`/api/chats/${activeChat.id}/members/${me.id}`, { method: "DELETE" });
    closeModal("groupInfoModal"); activeChat = null; $("appView").classList.remove("chat-open"); $("chatView").classList.add("hidden"); $("welcome").classList.remove("hidden");
    await loadChats(); toast("Gruptan ayrıldın.");
  } catch (e) { $("groupInfoError").textContent = e.message; }
};

// Message reactions and search
async function reactToMessage(id, emoji) { try { await api(`/api/messages/${id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) }); } catch (e) { toast(e.message); } }
$("chatSearchBtn").onclick = () => { $("chatSearchBar").classList.toggle("hidden"); $("chatSearchInput").focus(); };
$("closeChatSearch").onclick = () => { $("chatSearchInput").value = ""; $("chatSearchBar").classList.add("hidden"); loadMessages(); };
let messageSearchTimer;
$("chatSearchInput").oninput = () => { clearTimeout(messageSearchTimer); const q = $("chatSearchInput").value.trim(); messageSearchTimer = setTimeout(() => loadMessages(q), 250); };

// Status updates
function openStatus() { $("statusCaption").value = ""; $("statusImageInput").value = ""; $("statusImageName").textContent = ""; $("statusError").textContent = ""; showModal("statusModal"); }
$("statusForm").onsubmit = async e => {
  e.preventDefault(); const caption = $("statusCaption").value.trim(); const file = $("statusImageInput").files[0];
  try { let mediaId = null; if (file) mediaId = (await uploadMedia(file, "status")).id; await api("/api/statuses", { method: "POST", body: JSON.stringify({ caption, mediaId }) }); closeModal("statusModal"); toast("Durumun paylaşıldı."); if (currentTab === "updates") loadStatuses(); }
  catch (err) { $("statusError").textContent = err.message; }
};
$("statusImageInput").onchange = () => { const f = $("statusImageInput").files[0]; $("statusImageName").textContent = f ? f.name : ""; };
async function loadStatuses() {
  try { statusGroups = await api("/api/statuses"); $("chatList").innerHTML = "";
    const own = statusGroups.find(g => g.userId === me.id);
    const mine = document.createElement("div"); mine.className = "chat-item"; const av = document.createElement("div"); av.className = "avatar"; setAvatar(av, me);
    const info = document.createElement("div"); info.className = "chat-info"; const b = document.createElement("b"); b.textContent = "Durumum"; const p = document.createElement("p"); p.textContent = own ? `${own.items.length} paylaşım · Yeni durum ekle` : "Henüz paylaşım yok · Dokun ve ekle"; info.append(b, p); mine.append(av, info); mine.onclick = openStatus; $("chatList").appendChild(mine);
    statusGroups.filter(g => g.userId !== me.id).forEach((g, i) => { const row = document.createElement("div"); row.className = "chat-item"; const avatar = document.createElement("div"); avatar.className = "avatar"; setAvatar(avatar, { display_name: g.displayName, avatar_url: g.avatarUrl }); const inf = document.createElement("div"); inf.className = "chat-info"; const n = document.createElement("b"); n.textContent = g.displayName; const p2 = document.createElement("p"); p2.textContent = `${g.items.length} durum güncellemesi`; inf.append(n, p2); row.append(avatar, inf); row.onclick = () => openStatusGroup(statusGroups.indexOf(g)); $("chatList").appendChild(row); });
    if (statusGroups.length <= 1) { const empty = document.createElement("div"); empty.style.cssText = "padding:20px 16px;color:#9aa8a3;font-size:11px;line-height:1.6"; empty.textContent = "Diğer kişilerin durum paylaşımları burada görünür. Durumlar 24 saat sonra kaybolur."; $("chatList").appendChild(empty); }
  } catch (e) { toast(e.message); }
}
function openStatusGroup(groupIndex) { statusGroupIndex = groupIndex; statusItemIndex = 0; showModal("statusViewer"); showStatusItem(); }
async function showStatusItem() {
  const group = statusGroups[statusGroupIndex]; if (!group) return closeModal("statusViewer");
  const item = group.items[statusItemIndex]; if (!item) return closeModal("statusViewer");
  $("statusViewerName").textContent = group.displayName; $("statusViewerTime").textContent = formatTime(item.createdAt); setAvatar($("statusViewerAvatar"), { display_name: group.displayName, avatar_url: group.avatarUrl });
  const content = $("statusViewerContent"); content.innerHTML = "";
  if (item.mediaUrl) { const id = item.mediaUrl.split("/").pop(); const url = await mediaUrl(id); if (url) { const img = document.createElement("img"); img.src = url; img.alt = "Durum fotoğrafı"; content.appendChild(img); } }
  if (item.caption) { const text = document.createElement("div"); text.textContent = item.caption; content.appendChild(text); }
  $("statusProgressBar").style.width = `${((statusItemIndex + 1) / group.items.length) * 100}%`;
  $("statusPrev").style.display = statusItemIndex === 0 ? "none" : "block"; $("statusNext").style.display = statusItemIndex === group.items.length - 1 ? "none" : "block";
}
$("statusViewerClose").onclick = () => closeModal("statusViewer");
$("statusNext").onclick = () => { const g = statusGroups[statusGroupIndex]; if (statusItemIndex < g.items.length - 1) { statusItemIndex++; showStatusItem(); } };
$("statusPrev").onclick = () => { if (statusItemIndex > 0) { statusItemIndex--; showStatusItem(); } };

// Web Push notifications
function urlBase64ToUint8Array(base64String) {
  const normalized = String(base64String || "").trim();
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const raw = atob((normalized + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function sameBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left), b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}
async function getPushRegistration() {
  if (!("serviceWorker" in navigator)) throw new Error("Bu tarayıcı servis çalışanlarını desteklemiyor.");
  await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}
async function refreshPushButtonState() {
  const button = $("enablePushBtn");
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    button.textContent = "Desteklenmiyor"; button.disabled = true; return;
  }
  button.disabled = false;
  if (Notification.permission === "denied") { button.textContent = "Tarayıcı ayarlarından izin ver"; return; }
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    button.textContent = subscription && Notification.permission === "granted" ? "Bildirimler açık" : "Bildirimleri etkinleştir";
  } catch {
    button.textContent = "Bildirimleri etkinleştir";
  }
}
$("enablePushBtn").onclick = async () => {
  const button = $("enablePushBtn");
  button.disabled = true;
  try {
    if (!window.isSecureContext) throw new Error("Bildirimler için HTTPS bağlantısı gerekli.");
    if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
      throw new Error("Bu tarayıcı web bildirimlerini desteklemiyor.");
    }
    // Trigger the permission prompt directly from the click, before any network await.
    const permissionRequest = Notification.requestPermission();
    const [{ publicKey }, permission] = await Promise.all([
      api("/api/push/public-key"),
      permissionRequest
    ]);
    if (!publicKey) throw new Error("Sunucuda geçerli VAPID anahtarları yapılandırılmamış.");
    if (permission !== "granted") throw new Error(permission === "denied" ? "Bildirim izni tarayıcı ayarlarından engellenmiş." : "Bildirim izni verilmedi.");

    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    const registration = await getPushRegistration();
    let subscription = await registration.pushManager.getSubscription();
    const currentServerKey = subscription?.options?.applicationServerKey;
    // VAPID keys may have been rotated. An old subscription cannot be used with a new pair.
    if (subscription && currentServerKey && !sameBytes(currentServerKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
    toast("Bildirimler bu cihazda etkinleştirildi.");
    button.textContent = "Bildirimler açık";
  } catch (error) {
    toast(error.message || "Bildirimler etkinleştirilemedi.");
    await refreshPushButtonState();
  } finally {
    button.disabled = false;
  }
};

// WebRTC voice/video calls (one-to-one; production needs TURN relay configuration)
let rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
function showCall(name, state) { $("callName").textContent = name || "Kişi"; $("callState").textContent = state; setAvatar($("callAvatar"), { display_name: name }); $("callOverlay").classList.remove("hidden"); }
async function preparePeer(mode) {
  pc = new RTCPeerConnection(rtcConfig);
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  $("localVideo").srcObject = localStream; $("localVideo").style.display = mode === "video" ? "block" : "none";
  $("remoteVideo").style.display = mode === "video" ? "block" : "none";
  pc.ontrack = event => { $("remoteVideo").srcObject = event.streams[0]; $("remoteAudio").srcObject = event.streams[0]; };
  pc.onicecandidate = event => { const callChatId = currentCall?.chatId || activeChat?.id; if (event.candidate && callChatId) socket?.emit("call:ice", { chatId: callChatId, candidate: event.candidate }); };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (["connected", "connecting"].includes(pc.connectionState)) $("callState").textContent = pc.connectionState === "connected" ? "Bağlandı" : "Bağlanıyor...";
    if (pc.connectionState === "failed") { $("callState").textContent = "Bağlantı kurulamadı · TURN gerekebilir"; toast("Arama bağlantısı kurulamadı. Sunucu yöneticisi TURN ayarını kontrol etmeli."); }
    if (pc.connectionState === "disconnected") $("callState").textContent = "Bağlantı kesildi";
  };
  $("incomingActions").classList.add("hidden"); $("activeCallActions").classList.remove("hidden");
}
async function startCall(mode) {
  if (!activeChat || activeChat.is_group) return toast("Aramalar şimdilik birebir sohbetlerde kullanılabilir.");
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast("Bu tarayıcı aramaları desteklemiyor.");
  try {
    pendingIce = []; currentCall = { chatId: activeChat.id, mode }; showCall(chatName(activeChat), "Aranıyor..."); await preparePeer(mode);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit("call:invite", { chatId: activeChat.id, mode, offer });
  } catch (e) { toast(e.message || "Mikrofon veya kamera izni gerekli."); endCall(false); }
}
$("audioCallBtn").onclick = () => startCall("audio"); $("videoCallBtn").onclick = () => startCall("video");
$("acceptCallBtn").onclick = async () => {
  if (!incomingCall) return;
  try { currentCall = { chatId: incomingCall.chatId, mode: incomingCall.mode }; await preparePeer(incomingCall.mode); await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
    for (const c of pendingIce) await pc.addIceCandidate(c); pendingIce = [];
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit("call:answer", { chatId: incomingCall.chatId, answer }); incomingCall = null;
  } catch (e) { toast(e.message); endCall(true); }
};
$("rejectCallBtn").onclick = () => { if (incomingCall) socket?.emit("call:end", { chatId: incomingCall.chatId }); incomingCall = null; endCall(false); };
$("endCallBtn").onclick = () => endCall(true);
async function endCall(notify = true) {
  const chatId = currentCall?.chatId || incomingCall?.chatId || activeChat?.id;
  if (notify && chatId) socket?.emit("call:end", { chatId });
  if (pc) { pc.onicecandidate = null; pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  $("localVideo").srcObject = null; $("remoteVideo").srcObject = null; $("remoteAudio").srcObject = null; $("callOverlay").classList.add("hidden"); $("incomingActions").classList.add("hidden"); $("activeCallActions").classList.add("hidden");
  currentCall = null; incomingCall = null; pendingIce = [];
}
$("muteCallBtn").onclick = () => { if (!localStream) return; const track = localStream.getAudioTracks()[0]; if (track) { track.enabled = !track.enabled; $("muteCallBtn").textContent = track.enabled ? "🎙 Mikrofon" : "🔇 Mikrofon kapalı"; } };
$("cameraCallBtn").onclick = () => { if (!localStream) return; const track = localStream.getVideoTracks()[0]; if (track) { track.enabled = !track.enabled; $("cameraCallBtn").textContent = track.enabled ? "▣ Kamera" : "Kamera kapalı"; } };

// Realtime socket
function connectSocket() {
  socket = io({ auth: { token }, transports: ["websocket", "polling"] });
  socket.on("connect_error", () => toast("Canlı bağlantı kurulamadı. Sayfayı yenilemeyi dene."));
  socket.on("message:new", m => {
    if (activeChat && Number(m.chat_id) === Number(activeChat.id)) {
      addMessage(m);
      if (isActiveChatVisible()) markActiveChatRead();
    }
    if (currentTab === "chats" || currentTab === "archived") loadChats();
  });
  socket.on("typing", d => { if (activeChat && Number(d.chatId) === Number(activeChat.id) && Number(d.userId) !== Number(me.id)) $("typingLine").textContent = d.active ? "Karşı taraf yazıyor..." : ""; });
  socket.on("presence:list", d => { onlineUsers = new Set((d.userIds || []).map(Number)); if (activeChat) refreshChatSubtitle(); });
  socket.on("presence:update", d => { if (d.online) onlineUsers.add(Number(d.userId)); else onlineUsers.delete(Number(d.userId)); if (activeChat) refreshChatSubtitle(); });
  socket.on("chat:delivered", d => {
    if (!activeChat || Number(d.chatId) !== Number(activeChat.id) || Number(d.userId) === Number(me.id)) return;
    const deliveredAt = Date.parse(d.at || "");
    if (!Number.isFinite(deliveredAt)) return;
    document.querySelectorAll(".message-row.mine[data-created-at]").forEach(row => {
      const createdAt = Date.parse(row.dataset.createdAt);
      if (!Number.isFinite(createdAt) || createdAt > deliveredAt) return;
      const ticks = row.querySelector(".message-ticks");
      if (ticks && !ticks.classList.contains("read")) ticks.textContent = "✓✓";
    });
  });
  socket.on("chat:read", d => {
    if (activeChat && Number(d.chatId) === Number(activeChat.id) && Number(d.userId) !== Number(me.id)) {
      // Re-fetch per-message read state; in groups every recipient must have read it.
      loadMessages();
    }
  });
  socket.on("message:updated", d => { if (activeChat && Number(d.chat_id) === Number(activeChat.id)) loadMessages(); if (currentTab === "chats" || currentTab === "archived") loadChats(); });
  socket.on("message:deleted", d => { if (activeChat && Number(d.chatId) === Number(activeChat.id)) loadMessages(); if (currentTab === "chats" || currentTab === "archived") loadChats(); });
  socket.on("message:reactions", d => { if (activeChat && Number(d.chatId) === Number(activeChat.id)) loadMessages(); });
  socket.on("status:new", () => { if (currentTab === "updates") loadStatuses(); });
  socket.on("chat:updated", d => { const item = chats.find(c => Number(c.id) === Number(d.chatId)); if (item) item.title = d.title; if (activeChat && Number(activeChat.id) === Number(d.chatId)) { activeChat.title = d.title; $("chatTitle").textContent = d.title; } renderChats(); });
  socket.on("chat:members", d => { if (activeChat && Number(activeChat.id) === Number(d.chatId)) loadChats(); });
  socket.on("call:incoming", d => {
    if (currentCall) { socket.emit("call:end", { chatId: d.chatId }); return; }
    incomingCall = d; pendingIce = []; const chat = chats.find(c => Number(c.id) === Number(d.chatId)); const other = chat?.members?.[0];
    if (chat) { activeChat = chat; $("appView").classList.add("chat-open"); $("chatView").classList.remove("hidden"); $("welcome").classList.add("hidden"); $("chatTitle").textContent = chatName(chat); setAvatar($("chatAvatar"), other || chat); $("audioCallBtn").disabled = false; $("videoCallBtn").disabled = false; refreshChatSubtitle(); loadMessages(); }
    showCall(other?.display_name || "Gelen arama", d.mode === "video" ? "Görüntülü arama geliyor" : "Sesli arama geliyor"); $("incomingActions").classList.remove("hidden"); $("activeCallActions").classList.add("hidden");
  });
  socket.on("call:answered", async d => { if (pc && Number(d.chatId) === Number(currentCall?.chatId)) { try { await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); for (const c of pendingIce) await pc.addIceCandidate(c); pendingIce = []; $("callState").textContent = "Bağlanıyor..."; } catch (e) { toast("Arama bağlantısı kurulamadı."); } } });
  socket.on("call:ice", async d => { const callChatId = currentCall?.chatId || incomingCall?.chatId; if (Number(d.chatId) !== Number(callChatId)) return; const candidate = new RTCIceCandidate(d.candidate); if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(candidate); } catch {} } else pendingIce.push(candidate); });
  socket.on("call:ended", d => { if (Number(d.chatId) === Number(currentCall?.chatId || incomingCall?.chatId)) endCall(false); });
  socket.on("call:error", d => { toast(d.message); endCall(false); });
}

// If the user returns to the app while a chat is open, mark it read now (not while backgrounded).
function handleForegroundReturn() {
  if (isActiveChatVisible()) markActiveChatRead();
}
document.addEventListener("visibilitychange", handleForegroundReturn);
window.addEventListener("focus", handleForegroundReturn);

// App bootstrap
async function boot() {
  try {
    if (!token) throw new Error("Giriş gerekli.");
    const [user, cfg] = await Promise.all([api("/api/me"), api("/api/config")]);
    me = user; config = cfg; rtcConfig = { iceServers: Array.isArray(cfg.rtcIceServers) && cfg.rtcIceServers.length ? cfg.rtcIceServers : [{ urls: "stun:stun.l.google.com:19302" }] }; $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
    $("myName").textContent = me.display_name; $("myHandle").textContent = `@${me.username}`; setAvatar($("myAvatar"), me, true);
    setTheme(localStorage.getItem("mesaj_dark") === "1"); await loadChats();
    if (socket) socket.disconnect(); connectSocket();
    const requestedChat = new URLSearchParams(location.search).get("chat");
    if (requestedChat) {
      const targetChat = chats.find(c => Number(c.id) === Number(requestedChat));
      if (targetChat) await openChat(targetChat);
      history.replaceState({}, "", location.pathname);
    }
    if ("serviceWorker" in navigator) {
      getPushRegistration().catch(error => console.warn("Service worker kaydedilemedi:", error));
    }
  } catch (e) {
    if (socket) socket.disconnect(); localStorage.removeItem("mesaj_token"); token = null;
    $("authView").classList.remove("hidden"); $("appView").classList.add("hidden");
  }
}
boot();
