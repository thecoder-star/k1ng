import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { APP_CONFIG, isSupabaseConfigured } from "./config.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
const resolveTemplateUrl = (url = "") =>
  url
    .replaceAll("{COVER_URL}", APP_CONFIG.gameCoverBase.replace(/\/+$/, ""))
    .replaceAll("{HTML_URL}", APP_CONFIG.gameHtmlBase.replace(/\/+$/, ""));
const initials = (value = "A") => value.trim().slice(0, 2).toUpperCase();
const formatTime = (date) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(date));
const uid = () => crypto.randomUUID();

const state = {
  supabase: null,
  user: null,
  profile: null,
  isAdmin: false,
  demo: false,
  games: [],
  filteredGames: [],
  conversations: [],
  conversationsSignature: "",
  activeConversation: null,
  activeMembers: [],
  messageChannel: null,
  globalChannel: null,
  callChannel: null,
  call: null,
  chatPollTimer: null,
  chatPollInFlight: false,
  lastChatError: "",
  activeMessagesSignature: "",
  recorder: null,
  recordChunks: [],
  uploads: [],
  settings: {},
};

function toast(message, tone = "") {
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 3600);
}

function avatarMarkup(profile, className = "avatar") {
  const name = profile?.username || "User";
  return `<div class="${className}">${
    profile?.avatar_url
      ? `<img src="${escapeHtml(profile.avatar_url)}" alt="" />`
      : escapeHtml(initials(name))
  }</div>`;
}

function openModal(title, content) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = content;
  $("#modal").classList.remove("hidden");
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modalBody").replaceChildren();
}

function showApp() {
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  route();
}

function showAuth() {
  $("#appShell").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
}

function route() {
  const requested = location.hash.replace("#", "") || "games";
  const view = requested === "admin" && !state.isAdmin ? "games" : requested;
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}View`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  if (view === "chat" && !state.demo) loadConversations();
  if (view === "friends" && !state.demo) loadFriends();
  if (view === "profile") renderProfile();
  if (view === "admin" && state.isAdmin) loadAdminGames();
}

function setAuthMode(mode) {
  const signup = mode === "signup";
  $$(".segment").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
  $("#authForm").dataset.mode = mode;
  $("#usernameField").classList.toggle("hidden", !signup);
  $("#authUsername").required = signup;
  $("#authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("#authSubmit").textContent = signup ? "Create account" : "Continue";
  $("#authMessage").textContent = "";
}

async function handleAuth(event) {
  event.preventDefault();
  if (!state.supabase) {
    $("#authMessage").textContent = "Configure Supabase in assets/js/config.js or use Preview.";
    return;
  }
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const mode = $("#authForm").dataset.mode || "signin";
  $("#authSubmit").disabled = true;
  $("#authMessage").textContent = "Working…";
  let result;
  if (mode === "signup") {
    result = await state.supabase.auth.signUp({
      email,
      password,
      options: { data: { username: $("#authUsername").value.trim() } },
    });
    $("#authMessage").textContent = result.error ? result.error.message : "Check your email to confirm your account.";
  } else {
    result = await state.supabase.auth.signInWithPassword({ email, password });
    $("#authMessage").textContent = result.error ? result.error.message : "";
  }
  $("#authSubmit").disabled = false;
}

async function enterDemo() {
  state.demo = true;
  state.user = { id: "demo-user", email: "preview@local" };
  state.profile = {
    id: state.user.id,
    username: "Preview",
    friend_code: "PREVIEW1",
    bio: "A local preview. Connect Supabase to enable social features.",
  };
  showApp();
  await loadGames();
  renderProfile();
}

async function initializeSupabase() {
  if (!isSupabaseConfigured()) return;
  state.supabase = createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  await loadPublicSettings();
  const { data } = await state.supabase.auth.getSession();
  if (data.session?.user) await setSessionUser(data.session.user);
  state.supabase.auth.onAuthStateChange((_event, session) => {
    queueMicrotask(async () => {
      if (session?.user) await setSessionUser(session.user);
      else {
        state.user = null;
        state.profile = null;
        showAuth();
      }
    });
  });
}

async function setSessionUser(user) {
  state.user = user;
  state.demo = false;
  await Promise.all([loadProfile(), loadPublicSettings()]);
  showApp();
  await Promise.all([loadGames(), loadConversations()]);
  subscribeAccountEvents();
  startChatPolling();
  const pendingFriendCode = sessionStorage.getItem("pending_friend_code");
  if (pendingFriendCode && confirm(`Send a friend request using code ${pendingFriendCode}?`)) {
    const { error } = await state.supabase.rpc("send_friend_request", {
      target_code: pendingFriendCode.toUpperCase(),
    });
    toast(error ? error.message : "Friend request sent.");
    sessionStorage.removeItem("pending_friend_code");
  }
}

async function loadProfile() {
  let { data, error } = await state.supabase
    .from("profiles")
    .select("*")
    .eq("id", state.user.id)
    .maybeSingle();
  if (!error && !data) {
    const ensured = await state.supabase.rpc("ensure_current_profile");
    if (ensured.error) {
      toast(ensured.error.message, "error");
      return;
    }
    const retry = await state.supabase
      .from("profiles")
      .select("*")
      .eq("id", state.user.id)
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    toast(error.message, "error");
    return;
  }
  if (!data) {
    toast("Your profile could not be created. Apply the latest Supabase migration.", "error");
    return;
  }
  state.profile = data;
  const claimedAdmin = await state.supabase.rpc("claim_first_admin");
  const { data: admin } = claimedAdmin.error
    ? await state.supabase.rpc("is_admin")
    : { data: claimedAdmin.data };
  state.isAdmin = Boolean(admin);
  $("#adminNav").classList.toggle("hidden", !state.isAdmin);
  if (state.isAdmin) $("#adminNav").title = "Administration";
  renderProfile();
}

async function loadPublicSettings() {
  if (!state.supabase) return;
  const { data } = await state.supabase.rpc("get_public_app_settings");
  const settings = data?.[0] || {};
  state.settings = settings;
  if (settings.lock_enabled && sessionStorage.getItem("k1ng_access") !== settings.lock_version) {
    $("#accessGate").classList.remove("hidden");
  }
  if (settings.notification_enabled && settings.notification_text) {
    const delay = Math.max(0, settings.notification_delay_seconds || 0) * 1000;
    setTimeout(() => {
      $("#globalNotice").textContent = settings.notification_text;
      $("#globalNotice").classList.remove("hidden");
      openModal("Notice", `<p>${escapeHtml(settings.notification_text)}</p>`);
      if (settings.notification_duration_seconds > 0) {
        setTimeout(() => {
          $("#globalNotice").classList.add("hidden");
          if ($("#modalTitle").textContent === "Notice") closeModal();
        }, settings.notification_duration_seconds * 1000);
      }
    }, delay);
  }
}

async function unlockAccess(event) {
  event.preventDefault();
  $("#accessError").textContent = "";
  const { data, error } = await state.supabase.functions.invoke("access-gate", {
    body: { password: $("#accessPassword").value },
  });
  if (error || !data?.ok) {
    $("#accessError").textContent = "That password is not correct.";
    return;
  }
  sessionStorage.setItem("k1ng_access", String(data.lockVersion));
  $("#accessGate").classList.add("hidden");
}

async function loadGames() {
  $("#gameGrid").innerHTML = `<p class="muted">Loading the library…</p>`;
  let remote = [];
  try {
    const response = await fetch(`${APP_CONFIG.gameCatalogUrl}?t=${Date.now()}`);
    if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
    const payload = await response.json();
    remote = payload
      .slice(0, APP_CONFIG.maxCatalogGames)
      .filter((game) => {
        const url = resolveTemplateUrl(game.url);
        return url.startsWith(APP_CONFIG.gameHtmlBase) && /\.html(?:$|\?)/i.test(url);
      })
      .map((game) => ({
        id: `remote-${game.id}`,
        source_id: String(game.id),
        name: game.name || "Untitled",
        author: game.author || "Unknown",
        html_url: resolveTemplateUrl(game.url),
        cover_url: resolveTemplateUrl(game.cover),
        featured: Boolean(game.featured),
        sort_order: Number(game.id) || 0,
        source: "remote",
      }));
  } catch (error) {
    toast(`Game catalog unavailable: ${error.message}`);
  }
  let managed = [];
  if (state.supabase && !state.demo) {
    const { data } = await state.supabase.from("games").select("*").eq("published", true);
    managed = (data || []).map((game) => ({ ...game, source: "managed" }));
  }
  const managedUrls = new Set(managed.map((game) => game.html_url));
  state.games = [...managed, ...remote.filter((game) => !managedUrls.has(game.html_url))];
  if (!state.games.some((game) => game.featured)) {
    state.games.slice(0, 3).forEach((game) => { game.featured = true; });
  }
  filterGames();
}

function filterGames() {
  const query = $("#gameSearch").value.trim().toLowerCase();
  const sort = $("#gameSort").value;
  state.filteredGames = state.games.filter((game) =>
    `${game.name} ${game.author}`.toLowerCase().includes(query),
  );
  if (sort === "name") state.filteredGames.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "newest") state.filteredGames.sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0));
  if (sort === "featured") state.filteredGames.sort((a, b) => Number(b.featured) - Number(a.featured));
  renderGames();
}

function gameCard(game) {
  return `<article class="game-card" data-game-id="${escapeHtml(game.id)}" tabindex="0">
    <div class="game-cover"><img src="${escapeHtml(game.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>
    <div class="game-meta"><h3>${escapeHtml(game.name)}</h3><p>${escapeHtml(game.author || "Game")}</p></div>
  </article>`;
}

function renderGames() {
  const featured = state.games.filter((game) => game.featured).slice(0, 3);
  $("#featuredGames").innerHTML = featured.map((game) => `
    <article class="hero-game" data-game-id="${escapeHtml(game.id)}" tabindex="0">
      <img src="${escapeHtml(game.cover_url)}" alt="" referrerpolicy="no-referrer" />
      <div class="hero-copy"><p class="eyebrow">Featured</p><h2>${escapeHtml(game.name)}</h2><span>${escapeHtml(game.author || "")}</span></div>
    </article>`).join("");
  $("#gameGrid").innerHTML = state.filteredGames.length
    ? state.filteredGames.map(gameCard).join("")
    : `<div class="empty-state"><h2>No games found</h2><p>Try another search.</p></div>`;
  $("#gameCount").textContent = `${state.filteredGames.length} games`;
  $$("[data-game-id]").forEach((node) => {
    node.addEventListener("click", () => launchGame(node.dataset.gameId));
    node.addEventListener("keydown", (event) => event.key === "Enter" && launchGame(node.dataset.gameId));
  });
}

function injectBase(html, sourceUrl) {
  if (/<base\s+[^>]*href\s*=/i.test(html)) return html;
  const base = new URL(".", sourceUrl).href;
  const tag = `<base href="${escapeHtml(base)}">`;
  return /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${tag}`) : `${tag}${html}`;
}

async function getGameHtml(game) {
  const response = await fetch(`${game.html_url}${game.html_url.includes("?") ? "&" : "?"}t=${Date.now()}`);
  if (!response.ok) throw new Error(`Game returned ${response.status}`);
  return injectBase(await response.text(), game.html_url);
}

async function launchGame(id) {
  const game = state.games.find((item) => String(item.id) === String(id));
  if (!game) return;
  $("#viewerTitle").textContent = game.name;
  $("#gameViewer").classList.remove("hidden");
  $("#gameFrame").srcdoc = `<style>body{background:#050506;color:white;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}</style><p>Loading ${escapeHtml(game.name)}…</p>`;
  try {
    $("#gameFrame").srcdoc = await getGameHtml(game);
    localStorage.setItem("k1ng_recent_game", String(game.id));
  } catch (error) {
    $("#gameFrame").srcdoc = `<style>body{background:#09090b;color:white;font:16px system-ui;padding:2rem}</style><h1>Could not load this game</h1><p>${escapeHtml(error.message)}</p>`;
  }
}

async function openGameInNewTab() {
  const game = state.games.find((item) => item.name === $("#viewerTitle").textContent);
  const target = window.open("about:blank", "_blank");
  if (!target) return toast("Allow popups to open the game in a new tab.");
  try {
    const html = await getGameHtml(game);
    target.document.open();
    target.document.write(html);
    target.document.close();
  } catch (error) {
    target.close();
    toast(error.message);
  }
}

function renderProfile() {
  if (!state.profile) return;
  $("#profileUsername").value = state.profile.username || "";
  $("#profileBio").value = state.profile.bio || "";
  $("#friendCode").textContent = state.profile.friend_code || "—";
  $("#profileAvatar").src = state.profile.avatar_url || avatarDataUrl(state.profile.username);
}

function avatarDataUrl(name) {
  const label = initials(name);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop stop-color="#7c5cff"/><stop offset="1" stop-color="#4da3ff"/></linearGradient></defs><rect width="100" height="100" rx="28" fill="url(#g)"/><text x="50" y="58" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="34" font-family="system-ui" font-weight="700">${escapeHtml(label)}</text></svg>`)}`;
}

async function saveProfile(event) {
  event.preventDefault();
  if (state.demo) return toast("Connect Supabase to save your profile.");
  let avatarUrl = state.profile.avatar_url;
  const avatar = $("#avatarInput").files[0];
  if (avatar) {
    if (avatar.size > 5 * 1024 * 1024) return toast("Avatar must be under 5 MB.");
    const path = `${state.user.id}/${uid()}.${avatar.name.split(".").pop()}`;
    const { error } = await state.supabase.storage.from("avatars").upload(path, avatar);
    if (error) return toast(error.message);
    const { data } = state.supabase.storage.from("avatars").getPublicUrl(path);
    avatarUrl = data.publicUrl;
  }
  const updates = {
    username: $("#profileUsername").value.trim(),
    bio: $("#profileBio").value.trim(),
    avatar_url: avatarUrl,
  };
  const { data, error } = await state.supabase.from("profiles").update(updates).eq("id", state.user.id).select().single();
  $("#profileMessage").textContent = error ? error.message : "Saved.";
  if (!error) {
    state.profile = data;
    renderProfile();
  }
}

async function loadFriends() {
  const [{ data: requests }, { data: friends }] = await Promise.all([
    state.supabase.from("friend_requests_view").select("*").order("created_at", { ascending: false }),
    state.supabase.from("friends_view").select("*").order("username"),
  ]);
  $("#requestCount").textContent = requests?.length || 0;
  $("#friendCount").textContent = friends?.length || 0;
  $("#requestList").innerHTML = requests?.length
    ? requests.map((request) => `<article class="person">${avatarMarkup(request)}<div class="person-copy"><h3>${escapeHtml(request.username)}</h3><p>Wants to be friends</p></div><button class="button primary" data-accept="${request.request_id}">Accept</button><button class="icon-button" data-decline="${request.request_id}">×</button></article>`).join("")
    : `<p class="muted">No pending requests.</p>`;
  $("#friendList").innerHTML = friends?.length
    ? friends.map((friend) => `<article class="person">${avatarMarkup(friend)}<div class="person-copy"><h3>${escapeHtml(friend.username)}</h3><p>${escapeHtml(friend.bio || "Friend")}</p></div><button class="button" data-message-user="${friend.id}">Message</button></article>`).join("")
    : `<p class="muted">Add a friend with their code.</p>`;
  $$("[data-accept]").forEach((button) => button.onclick = () => respondFriend(button.dataset.accept, true));
  $$("[data-decline]").forEach((button) => button.onclick = () => respondFriend(button.dataset.decline, false));
  $$("[data-message-user]").forEach((button) => button.onclick = () => startDirectChat(button.dataset.messageUser));
}

function showAddFriend() {
  if (state.demo) return toast("Connect Supabase to add friends.");
  openModal("Add a friend", `<form id="addFriendForm"><label class="field"><span>Friend code or link</span><input id="friendCodeInput" required placeholder="ABCD1234" /></label><button class="button primary full" type="submit">Send request</button><p id="friendResult" class="form-message"></p></form>`);
  $("#addFriendForm").onsubmit = sendFriendRequest;
}

async function sendFriendRequest(event) {
  event.preventDefault();
  const raw = $("#friendCodeInput").value.trim();
  const code = raw.includes("friend=") ? new URL(raw).searchParams.get("friend") : raw;
  const { error } = await state.supabase.rpc("send_friend_request", { target_code: code.toUpperCase() });
  $("#friendResult").textContent = error ? error.message : "Request sent.";
}

async function respondFriend(requestId, accept) {
  const { error } = await state.supabase.rpc("respond_friend_request", {
    request_uuid: requestId,
    accept_request: accept,
  });
  if (error) toast(error.message);
  else loadFriends();
}

async function startDirectChat(userId) {
  const { data, error } = await state.supabase.rpc("create_direct_conversation", { other_user: userId });
  if (error) return toast(error.message);
  location.hash = "chat";
  await loadConversations();
  await openConversation(data);
}

function subscribeAccountEvents() {
  if (state.globalChannel) state.supabase.removeChannel(state.globalChannel);
  state.globalChannel = state.supabase
    .channel(`account-events:${state.user.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      async ({ new: message }) => {
        if (message.conversation_id === state.activeConversation) {
          await openConversation(state.activeConversation);
        } else {
          await loadConversations();
          if (message.sender_id !== state.user.id) toast("New message received.");
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "message_attachments" },
      async () => {
        if (state.activeConversation) await openConversation(state.activeConversation);
      },
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "call_sessions",
        filter: `recipient_id=eq.${state.user.id}`,
      },
      ({ new: call }) => showIncomingCall(call),
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") toast("Realtime connection failed. Refresh the page.");
      if (status === "SUBSCRIBED") checkPendingCalls();
    });
}

async function checkPendingCalls() {
  const { data } = await state.supabase
    .from("call_sessions")
    .select("*")
    .eq("recipient_id", state.user.id)
    .eq("status", "ringing")
    .order("started_at", { ascending: false })
    .limit(1);
  if (data?.[0]) showIncomingCall(data[0]);
}

function startChatPolling() {
  if (state.chatPollTimer) clearInterval(state.chatPollTimer);
  state.chatPollTimer = setInterval(async () => {
    if (!state.user || state.demo || state.chatPollInFlight || document.hidden) return;
    state.chatPollInFlight = true;
    try {
      await loadConversations();
      await refreshActiveMessages();
    } finally {
      state.chatPollInFlight = false;
    }
  }, 2500);
}

async function loadConversations() {
  if (!state.supabase || state.demo) {
    $("#conversationList").innerHTML = `<p class="muted" style="padding:1rem">Connect Supabase to enable private chats.</p>`;
    return;
  }
  const { data, error } = await state.supabase.from("conversation_summaries").select("*").order("last_message_at", { ascending: false });
  if (error) return toast(error.message);
  state.conversations = data || [];
  const unread = state.conversations.reduce((total, item) => total + (item.unread_count || 0), 0);
  $("#unreadBadge").textContent = String(unread);
  $("#unreadBadge").classList.toggle("hidden", unread === 0);
  const signature = JSON.stringify(state.conversations.map((item) => [
    item.conversation_id,
    item.title,
    item.avatar_url,
    item.last_message,
    item.last_message_at,
    item.unread_count,
  ]));
  if (signature !== state.conversationsSignature) {
    state.conversationsSignature = signature;
    renderConversations();
  }
}

function renderConversations() {
  const query = $("#chatSearch").value.trim().toLowerCase();
  const items = state.conversations.filter((item) => item.title.toLowerCase().includes(query));
  $("#conversationList").innerHTML = items.length
    ? items.map((item) => `<article class="conversation-item ${item.conversation_id === state.activeConversation ? "active" : ""}" data-conversation="${item.conversation_id}">${avatarMarkup({ username: item.title, avatar_url: item.avatar_url })}<div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.last_message || "Start the conversation")}</p></div><time>${item.last_message_at ? formatTime(item.last_message_at) : ""}</time></article>`).join("")
    : `<p class="muted" style="padding:1rem">No conversations yet.</p>`;
  $$("[data-conversation]").forEach((node) => node.onclick = () => openConversation(node.dataset.conversation));
}

async function openConversation(id) {
  if (state.activeConversation !== id) state.activeMessagesSignature = "";
  state.activeConversation = id;
  const summary = state.conversations.find((item) => item.conversation_id === id);
  $(".messenger").classList.add("thread-open");
  $("#emptyThread").classList.add("hidden");
  $("#activeThread").classList.remove("hidden");
  $("#threadTitle").textContent = summary?.title || "Conversation";
  $("#threadAvatar").innerHTML = summary?.avatar_url ? `<img src="${escapeHtml(summary.avatar_url)}" alt="" />` : initials(summary?.title);
  renderConversations();
  const { data: members, error: memberError } = await state.supabase
    .from("conversation_members")
    .select("user_id")
    .eq("conversation_id", id);
  if (memberError) {
    toast(`Could not open chat: ${memberError.message}`);
    return;
  }
  state.activeMembers = members || [];
  await refreshActiveMessages(id);
  await state.supabase.rpc("mark_conversation_read", { target_conversation: id });
  subscribeConversation(id);
}

async function refreshActiveMessages(id = state.activeConversation) {
  if (!id || id !== state.activeConversation) return;
  const { data: messages, error } = await state.supabase.rpc("get_conversation_messages", {
    target_conversation: id,
    row_limit: 250,
  });
  if (error) {
    console.error("Could not refresh messages", error);
    if (state.lastChatError !== error.message) toast(`Messages could not load: ${error.message}`);
    state.lastChatError = error.message;
    return;
  }
  state.lastChatError = "";
  const messageIds = (messages || []).map((message) => message.id);
  let attachmentsByMessage = new Map();
  if (messageIds.length) {
    const { data: attachments, error: attachmentError } = await state.supabase
      .from("message_attachments")
      .select("*")
      .in("message_id", messageIds);
    if (!attachmentError) {
      attachmentsByMessage = (attachments || []).reduce((map, attachment) => {
        const existing = map.get(attachment.message_id) || [];
        existing.push(attachment);
        map.set(attachment.message_id, existing);
        return map;
      }, new Map());
    }
  }
  const signature = JSON.stringify((messages || []).map((message) => [
    message.id,
    message.body,
    message.edited_at,
    message.deleted_at,
    message.read_at,
    (attachmentsByMessage.get(message.id) || []).map((attachment) => [
      attachment.id,
      attachment.storage_path,
    ]),
  ]));
  if (signature === state.activeMessagesSignature) return;
  state.activeMessagesSignature = signature;
  const hydratedMessages = await Promise.all((messages || []).map(async (message) => {
    const attachments = await Promise.all((attachmentsByMessage.get(message.id) || []).map(async (attachment) => {
      const { data } = await state.supabase.storage.from("chat-media").createSignedUrl(attachment.storage_path, 3600);
      return { ...attachment, signed_url: data?.signedUrl || "" };
    }));
    return { ...message, message_attachments: attachments };
  }));
  if (id !== state.activeConversation) return;
  renderMessages(hydratedMessages);
}

function attachmentMarkup(attachment) {
  const url = escapeHtml(attachment.signed_url || attachment.storage_path || "");
  if (attachment.kind === "image") return `<img src="${url}" alt="Shared image" />`;
  if (attachment.kind === "video") return `<video src="${url}" controls playsinline></video>`;
  if (attachment.kind === "voice") return `<audio src="${url}" controls></audio>`;
  return "";
}

function renderMessages(messages) {
  const list = $("#messageList");
  const wasEmpty = list.childElementCount === 0;
  const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  list.innerHTML = messages.map((message) => {
    const mine = message.sender_id === state.user.id;
    return `<div class="message-row ${mine ? "mine" : ""}">
      <div class="bubble">${(message.message_attachments || []).map(attachmentMarkup).join("")}${message.body ? `<div>${escapeHtml(message.body)}</div>` : ""}<time>${formatTime(message.created_at)}${mine && message.read_at ? " · Read" : ""}</time></div>
    </div>`;
  }).join("");
  if (wasEmpty || distanceFromBottom < 100) {
    list.scrollTop = list.scrollHeight;
  } else {
    list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - distanceFromBottom);
  }
}

function subscribeConversation(id) {
  if (state.messageChannel) state.supabase.removeChannel(state.messageChannel);
  state.messageChannel = state.supabase.channel(`conversation:${id}`, {
    config: { private: true, broadcast: { self: false } },
  });
  state.messageChannel
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      $("#typingStatus").textContent = payload.userId === state.user.id ? "" : `${payload.username} is typing…`;
      setTimeout(() => $("#typingStatus").textContent = "", 1600);
    })
    .subscribe();
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.activeConversation) return;
  const body = $("#messageInput").value.trim();
  if (!body && !state.uploads.length) return;
  const { data: message, error } = await state.supabase
    .from("messages")
    .insert({ conversation_id: state.activeConversation, sender_id: state.user.id, body: body || null })
    .select()
    .single();
  if (error) return toast(error.message);
  for (const upload of state.uploads) {
    const path = `${state.activeConversation}/${state.user.id}/${uid()}-${upload.file.name.replace(/[^\w.-]/g, "_")}`;
    const { error: uploadError } = await state.supabase.storage.from("chat-media").upload(path, upload.file);
    if (uploadError) {
      toast(uploadError.message);
      continue;
    }
    await state.supabase.from("message_attachments").insert({
      message_id: message.id,
      uploader_id: state.user.id,
      storage_path: path,
      kind: upload.kind,
      mime_type: upload.file.type,
      size_bytes: upload.file.size,
    });
  }
  $("#messageInput").value = "";
  state.uploads = [];
  renderUploadPreview();
  await openConversation(state.activeConversation);
  await loadConversations();
}

function selectUploads(files, forcedKind) {
  for (const file of files) {
    if (file.size > APP_CONFIG.mediaMaxBytes) {
      toast(`${file.name} is larger than 25 MB.`);
      continue;
    }
    const kind = forcedKind || (file.type.startsWith("image/") ? "image" : "video");
    state.uploads.push({ file, kind });
  }
  renderUploadPreview();
}

function renderUploadPreview() {
  $("#uploadPreview").classList.toggle("hidden", !state.uploads.length);
  $("#uploadPreview").textContent = state.uploads.length
    ? `${state.uploads.length} attachment${state.uploads.length > 1 ? "s" : ""} ready`
    : "";
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordChunks = [];
    state.recorder = new MediaRecorder(stream);
    state.recorder.ondataavailable = (event) => event.data.size && state.recordChunks.push(event.data);
    state.recorder.onstop = () => {
      const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType });
      selectUploads([new File([blob], `voice-${Date.now()}.webm`, { type: blob.type })], "voice");
      stream.getTracks().forEach((track) => track.stop());
      $("#recordButton").textContent = "●";
    };
    state.recorder.start();
    $("#recordButton").textContent = "■";
    toast("Recording voice message…");
  } catch (error) {
    toast(`Microphone unavailable: ${error.message}`);
  }
}

async function newConversation() {
  if (state.demo) return toast("Connect Supabase to create chats.");
  const { data } = await state.supabase.from("friends_view").select("*").order("username");
  openModal("New conversation", `<form id="newConversationForm"><label class="field"><span>Conversation name (optional for groups)</span><input id="conversationName" maxlength="60" /></label><div class="people-list">${(data || []).map((friend) => `<label class="person"><input type="checkbox" name="member" value="${friend.id}" />${avatarMarkup(friend)}<span>${escapeHtml(friend.username)}</span></label>`).join("")}</div><button class="button primary full" type="submit">Create chat</button></form>`);
  $("#newConversationForm").onsubmit = async (event) => {
    event.preventDefault();
    const memberIds = $$('input[name="member"]:checked', event.currentTarget).map((input) => input.value);
    if (!memberIds.length) return toast("Choose at least one friend.");
    const { data: id, error } = await state.supabase.rpc("create_group_conversation", {
      conversation_name: $("#conversationName").value.trim() || null,
      member_ids: memberIds,
    });
    if (error) return toast(error.message);
    closeModal();
    location.hash = "chat";
    await loadConversations();
    openConversation(id);
  };
}

async function startCall(withVideo) {
  if (!state.activeConversation || state.activeMembers.length !== 2) {
    return toast("Live calls are available in direct chats.");
  }
  const recipient = state.activeMembers.find((member) => member.user_id !== state.user.id);
  if (!recipient) return toast("The other caller could not be found.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    const peer = createCallPeer(stream);
    state.call = {
      id: null,
      peer,
      stream,
      withVideo,
      initiator: true,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
    };
    showCallOverlay($("#threadTitle").textContent, "Ringing…");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const { data: call, error } = await state.supabase
      .from("call_sessions")
      .insert({
        conversation_id: state.activeConversation,
        started_by: state.user.id,
        recipient_id: recipient.user_id,
        has_video: withVideo,
        offer,
      })
      .select()
      .single();
    if (error) throw error;
    state.call.id = call.id;
    subscribeToCall(call.id);
    await flushLocalCandidates();
  } catch (error) {
    toast(`Call could not start: ${error.message}`);
    await endCall(false);
  }
}

function createCallPeer(stream) {
  const peer = new RTCPeerConnection({ iceServers: APP_CONFIG.iceServers });
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  peer.ontrack = ({ streams }) => {
    $("#remoteVideo").srcObject = streams[0];
    $("#callStatus").textContent = "Connected";
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "connected") $("#callStatus").textContent = "Connected";
    if (["failed", "disconnected"].includes(peer.connectionState)) $("#callStatus").textContent = "Reconnecting…";
    if (peer.connectionState === "closed") $("#callStatus").textContent = "Ended";
  };
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || !state.call) return;
    if (!state.call.id) state.call.pendingLocalCandidates.push(candidate.toJSON());
    else saveIceCandidate(candidate.toJSON());
  };
  return peer;
}

function showCallOverlay(title, status) {
  $("#localVideo").srcObject = state.call?.stream || null;
  $("#callOverlay").classList.remove("hidden");
  $("#callTitle").textContent = title || "Call";
  $("#callStatus").textContent = status;
  $("#cameraCall").classList.toggle("hidden", !state.call?.withVideo);
}

async function showIncomingCall(call) {
  if (state.call || call.status !== "ringing") return;
  await loadConversations();
  const conversation = state.conversations.find((item) => item.conversation_id === call.conversation_id);
  const callerName = conversation?.title || "A friend";
  openModal(
    call.has_video ? "Incoming video call" : "Incoming audio call",
    `<div class="incoming-call">${avatarMarkup({ username: callerName, avatar_url: conversation?.avatar_url })}<h2>${escapeHtml(callerName)}</h2><p class="muted">is calling you</p><div class="incoming-actions"><button id="declineIncomingCall" class="button ghost" type="button">Decline</button><button id="answerIncomingCall" class="button primary" type="button">Answer</button></div></div>`,
  );
  $("#declineIncomingCall").onclick = async () => {
    await state.supabase
      .from("call_sessions")
      .update({ status: "declined", ended_at: new Date().toISOString() })
      .eq("id", call.id);
    closeModal();
  };
  $("#answerIncomingCall").onclick = () => answerCall(call, callerName);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`${callerName} is calling`, { body: call.has_video ? "Incoming video call" : "Incoming audio call" });
  }
}

async function answerCall(call, callerName) {
  closeModal();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.has_video });
    const peer = createCallPeer(stream);
    state.call = {
      id: call.id,
      peer,
      stream,
      withVideo: call.has_video,
      initiator: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
    };
    showCallOverlay(callerName, "Connecting…");
    subscribeToCall(call.id);
    await peer.setRemoteDescription(call.offer);
    await loadExistingCandidates(call.id);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    const { error } = await state.supabase
      .from("call_sessions")
      .update({
        answer,
        status: "active",
        answered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", call.id);
    if (error) throw error;
    await flushLocalCandidates();
  } catch (error) {
    toast(`Could not answer: ${error.message}`);
    await endCall(true);
  }
}

function subscribeToCall(callId) {
  if (state.callChannel) state.supabase.removeChannel(state.callChannel);
  state.callChannel = state.supabase
    .channel(`call:${callId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "call_sessions", filter: `id=eq.${callId}` },
      async ({ new: call }) => {
        if (["ended", "declined", "missed"].includes(call.status)) {
          toast(call.status === "declined" ? "Call declined." : "Call ended.");
          await endCall(false);
          return;
        }
        if (state.call?.initiator && call.answer && !state.call.peer.remoteDescription) {
          await state.call.peer.setRemoteDescription(call.answer);
          await loadExistingCandidates(callId);
          await flushRemoteCandidates();
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "call_ice_candidates", filter: `call_id=eq.${callId}` },
      ({ new: row }) => {
        if (row.sender_id !== state.user.id) addRemoteCandidate(row.candidate);
      },
    )
    .subscribe();
}

async function saveIceCandidate(candidate) {
  if (!state.call?.id) return;
  const { error } = await state.supabase.from("call_ice_candidates").insert({
    call_id: state.call.id,
    sender_id: state.user.id,
    candidate,
  });
  if (error) console.error("Could not save ICE candidate", error);
}

async function flushLocalCandidates() {
  const candidates = state.call?.pendingLocalCandidates.splice(0) || [];
  await Promise.all(candidates.map(saveIceCandidate));
}

async function loadExistingCandidates(callId) {
  const { data } = await state.supabase
    .from("call_ice_candidates")
    .select("sender_id, candidate")
    .eq("call_id", callId)
    .neq("sender_id", state.user.id)
    .order("id");
  for (const row of data || []) await addRemoteCandidate(row.candidate);
}

async function addRemoteCandidate(candidate) {
  if (!state.call?.peer.remoteDescription) {
    state.call?.pendingRemoteCandidates.push(candidate);
    return;
  }
  try {
    await state.call.peer.addIceCandidate(candidate);
  } catch (error) {
    console.error("Could not add ICE candidate", error);
  }
}

async function flushRemoteCandidates() {
  const candidates = state.call?.pendingRemoteCandidates.splice(0) || [];
  for (const candidate of candidates) await addRemoteCandidate(candidate);
}

async function endCall(notify = true) {
  const callId = state.call?.id;
  if (notify && callId) {
    await state.supabase
      .from("call_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", callId);
  }
  state.call?.stream?.getTracks().forEach((track) => track.stop());
  state.call?.peer?.close();
  if (state.callChannel) {
    state.supabase.removeChannel(state.callChannel);
    state.callChannel = null;
  }
  state.call = null;
  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;
  $("#callOverlay").classList.add("hidden");
  $("#callStatus").textContent = "Calling";
}

async function adminInvoke(action, payload) {
  const { data, error } = await state.supabase.functions.invoke("admin-api", {
    body: { action, payload },
  });
  if (error || data?.error) throw new Error(data?.error || error.message);
  return data;
}

async function saveNotice(event) {
  event.preventDefault();
  try {
    await adminInvoke("update-settings", {
      notification_text: $("#noticeText").value.trim(),
      notification_delay_seconds: Number($("#noticeDelay").value),
      notification_duration_seconds: Number($("#noticeDuration").value),
      notification_enabled: $("#noticeEnabled").checked,
    });
    toast("Notification saved.");
  } catch (error) { toast(error.message); }
}

async function saveLock(event) {
  event.preventDefault();
  try {
    await adminInvoke("update-lock", {
      enabled: $("#lockEnabled").checked,
      password: $("#lockPassword").value || null,
    });
    $("#lockPassword").value = "";
    toast("Access lock updated.");
  } catch (error) { toast(error.message); }
}

async function saveGame(event) {
  event.preventDefault();
  try {
    let htmlUrl = $("#gameUrl").value.trim();
    const file = $("#gameFile").files[0];
    if (file) {
      const path = `${state.user.id}/${uid()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const { error: uploadError } = await state.supabase.storage.from("game-packages").upload(path, file, {
        contentType: "text/html",
      });
      if (uploadError) throw uploadError;
      const { data } = state.supabase.storage.from("game-packages").getPublicUrl(path);
      htmlUrl = data.publicUrl;
    }
    if (!htmlUrl) throw new Error("Enter a game URL or upload a self-contained HTML file.");
    await adminInvoke("upsert-game", {
      id: $("#gameId").value || null,
      name: $("#gameName").value.trim(),
      html_url: htmlUrl,
      cover_url: $("#gameCover").value.trim(),
      author: $("#gameAuthor").value.trim(),
      featured: $("#gameFeatured").checked,
      published: true,
    });
    event.currentTarget.reset();
    toast("Game published.");
    await Promise.all([loadAdminGames(), loadGames()]);
  } catch (error) { toast(error.message); }
}

async function loadAdminGames() {
  if (!state.isAdmin) return;
  const [{ data: games }, settingsResponse] = await Promise.all([
    state.supabase.from("games").select("*").order("created_at", { ascending: false }),
    adminInvoke("get-settings", {}),
  ]);
  const settings = settingsResponse?.settings || {};
  $("#noticeText").value = settings?.notification_text || "";
  $("#noticeDelay").value = settings?.notification_delay_seconds || 0;
  $("#noticeDuration").value = settings?.notification_duration_seconds || 0;
  $("#noticeEnabled").checked = Boolean(settings?.notification_enabled);
  $("#lockEnabled").checked = Boolean(settings?.lock_enabled);
  $("#adminGameList").innerHTML = (games || []).map((game) => `<div class="admin-list-row"><img src="${escapeHtml(game.cover_url)}" alt="" /><div><h3>${escapeHtml(game.name)}</h3><p>${escapeHtml(game.html_url)}</p></div><button class="text-button" data-edit-game="${game.id}">Edit</button><button class="text-button" data-delete-game="${game.id}">Delete</button></div>`).join("") || `<p class="muted">No managed games.</p>`;
  $$("[data-edit-game]").forEach((button) => button.onclick = () => {
    const game = games.find((item) => item.id === button.dataset.editGame);
    $("#gameId").value = game.id;
    $("#gameName").value = game.name;
    $("#gameUrl").value = game.html_url;
    $("#gameCover").value = game.cover_url;
    $("#gameAuthor").value = game.author || "";
    $("#gameFeatured").checked = game.featured;
  });
  $$("[data-delete-game]").forEach((button) => button.onclick = async () => {
    if (!confirm("Delete this managed game?")) return;
    try {
      await adminInvoke("delete-game", { id: button.dataset.deleteGame });
      await Promise.all([loadAdminGames(), loadGames()]);
    } catch (error) { toast(error.message); }
  });
}

function bindEvents() {
  window.addEventListener("hashchange", route);
  $$('[data-view="chat"]').forEach((link) => {
    link.addEventListener("click", () => {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    });
  });
  $$(".segment").forEach((button) => button.onclick = () => setAuthMode(button.dataset.authMode));
  $("#authForm").onsubmit = handleAuth;
  $("#demoButton").onclick = enterDemo;
  $("#accessForm").onsubmit = unlockAccess;
  $("#signOutButton").onclick = () => state.demo ? location.reload() : state.supabase.auth.signOut();
  $("#themeToggle").onclick = () => {
    document.documentElement.classList.toggle("light");
    localStorage.setItem("k1ng_theme", document.documentElement.classList.contains("light") ? "light" : "dark");
  };
  $("#gameSearch").oninput = filterGames;
  $("#gameSort").onchange = filterGames;
  $("#viewerClose").onclick = () => {
    $("#gameViewer").classList.add("hidden");
    $("#gameFrame").srcdoc = "";
  };
  $("#viewerFullscreen").onclick = () => $("#gameFrame").requestFullscreen?.();
  $("#viewerNewTab").onclick = openGameInNewTab;
  $("#modalClose").onclick = closeModal;
  $("#modal").onclick = (event) => event.target === $("#modal") && closeModal();
  $("#profileForm").onsubmit = saveProfile;
  $("#copyFriendCode").onclick = async () => {
    const link = `${location.origin}${location.pathname}?friend=${state.profile?.friend_code || ""}`;
    await navigator.clipboard.writeText(link);
    toast("Friend link copied.");
  };
  $("#addFriendButton").onclick = showAddFriend;
  $("#newChatButton").onclick = newConversation;
  $("#chatSearch").oninput = renderConversations;
  $("#messageForm").onsubmit = sendMessage;
  $("#messageInput").oninput = () => {
    $("#messageInput").style.height = "auto";
    $("#messageInput").style.height = `${Math.min($("#messageInput").scrollHeight, 130)}px`;
    state.messageChannel?.send({ type: "broadcast", event: "typing", payload: { userId: state.user.id, username: state.profile.username } });
  };
  $("#mediaInput").onchange = (event) => selectUploads(event.target.files);
  $("#recordButton").onclick = toggleRecording;
  $("#audioCallButton").onclick = () => startCall(false);
  $("#videoCallButton").onclick = () => startCall(true);
  $("#hangupCall").onclick = () => endCall();
  $("#muteCall").onclick = () => state.call?.stream?.getAudioTracks().forEach((track) => track.enabled = !track.enabled);
  $("#cameraCall").onclick = () => state.call?.stream?.getVideoTracks().forEach((track) => track.enabled = !track.enabled);
  $("#noticeForm").onsubmit = saveNotice;
  $("#lockForm").onsubmit = saveLock;
  $("#gameForm").onsubmit = saveGame;
  $("#refreshAdminGames").onclick = loadAdminGames;
}

async function start() {
  bindEvents();
  setAuthMode("signin");
  if (localStorage.getItem("k1ng_theme") === "light") document.documentElement.classList.add("light");
  const friendCode = new URLSearchParams(location.search).get("friend");
  if (friendCode) sessionStorage.setItem("pending_friend_code", friendCode);
  await initializeSupabase();
  if (!state.user) showAuth();
}

start().catch((error) => {
  console.error(error);
  toast(`Startup error: ${error.message}`);
});
