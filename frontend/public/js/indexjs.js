const GRAPHQL_URL = `${API_CONFIG.BASE_URL}/graphql`;
const WS_URL = `${API_CONFIG.BASE_URL.replace("http", "ws")}/graphql`;

let currentConversationId = null;
let currentFriendId = null;
let currentFriendUsername = null;
let selectedMessageId = null;
let selectedMessage = null;
let replyingToMessage = null;
let ws = null;
let subscriptionId = 1;
let endCursor = null;
let hasNextPage = false;
let allFriends = [];
let allConversations = new Map();
let myUserId = null;
let typingTimeout = null;
let isLoadingMore = false;
let activeReactionPicker = null;
let activeMenu = null;
let messageHoverStates = new Map();
let activeHoverTimeout = null;
let activeMessageActions = null;
let activeMessageHideTimeout = null;

let callCurrentCallId = null;
let callCurrentCallType = null;
let callIsInitiator = false;
let callPeerConnection = null;
let callLocalStream = null;
let callRemoteStream = null;
let callStunServers = [];
let callPendingIceCandidates = [];
let callIsMinimized = false;
let callIsMuted = false;
let callIsVideoOff = false;

const REACTION_EMOJIS = {
  1: "👍",
  2: "❤️",
  3: "😂",
  4: "😮",
  5: "😢",
  6: "😡",
};

const CacheManager = {
  MAX_CACHE_SIZE: 5 * 1024 * 1024,
  CACHE_EXPIRY: 24 * 60 * 60 * 1000,

  getCacheKey(conversationId) {
    return `chat_cache_${conversationId}`;
  },

  getMetaKey(conversationId) {
    return `chat_meta_${conversationId}`;
  },

  saveMessages(conversationId, messages, metadata = {}) {
    try {
      const cacheKey = this.getCacheKey(conversationId);
      const metaKey = this.getMetaKey(conversationId);

      const cacheData = {
        messages,
        timestamp: Date.now(),
        ...metadata,
      };

      localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      localStorage.setItem(
        metaKey,
        JSON.stringify({
          lastSync: Date.now(),
          messageCount: messages.length,
        }),
      );

      this.enforceStorageLimit();
    } catch (e) {
      this.clearOldestCache();
    }
  },

  loadMessages(conversationId) {
    try {
      const cacheKey = this.getCacheKey(conversationId);
      const cached = localStorage.getItem(cacheKey);

      if (!cached) return null;

      const data = JSON.parse(cached);

      if (Date.now() - data.timestamp > this.CACHE_EXPIRY) {
        localStorage.removeItem(cacheKey);
        return null;
      }

      return data.messages;
    } catch (e) {
      return null;
    }
  },

  updateMessageInCache(conversationId, updatedMessage) {
    const cached = this.loadMessages(conversationId);
    if (!cached) return;

    const index = cached.findIndex((m) => m.id === updatedMessage.id);
    if (index !== -1) {
      cached[index] = { ...cached[index], ...updatedMessage };
      this.saveMessages(conversationId, cached);
    }
  },

  addMessageToCache(conversationId, newMessage) {
    const cached = this.loadMessages(conversationId) || [];
    cached.push(newMessage);
    this.saveMessages(conversationId, cached);
  },

  enforceStorageLimit() {
    let totalSize = 0;
    for (let key in localStorage) {
      if (key.startsWith("chat_cache_")) {
        totalSize += localStorage.getItem(key).length;
      }
    }

    if (totalSize > this.MAX_CACHE_SIZE) {
      this.clearOldestCache();
    }
  },

  clearOldestCache() {
    let oldestKey = null;
    let oldestTime = Date.now();

    for (let key in localStorage) {
      if (key.startsWith("chat_meta_")) {
        const meta = JSON.parse(localStorage.getItem(key));
        if (meta.lastSync < oldestTime) {
          oldestTime = meta.lastSync;
          oldestKey = key.replace("chat_meta_", "");
        }
      }
    }

    if (oldestKey) {
      localStorage.removeItem(this.getCacheKey(oldestKey));
      localStorage.removeItem(this.getMetaKey(oldestKey));
    }
  },

  clearAll() {
    for (let key in localStorage) {
      if (key.startsWith("chat_cache_") || key.startsWith("chat_meta_")) {
        localStorage.removeItem(key);
      }
    }
  },
};

async function graphql(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0].message);
  }
  return result.data;
}

async function loadMe() {
  const data = await graphql(`  
    query {  
      me {  
        user {  
          id  
          username  
        }  
      }  
    }  
  `);
  myUserId = data.me.user.id;
  window.myUserId = myUserId;
}

async function loadFriends() {
  const data = await graphql(`  
    query {  
      myFriends {  
        friends {  
          friendId  
          friend {  
            id  
            username  
          }  
        }  
      }  
    }  
  `);

  allFriends = data.myFriends.friends;
  const friendsList = document.getElementById("friendsList");
  friendsList.innerHTML = "";

  const friendElements = [];
  for (const f of allFriends) {
    const div = document.createElement("div");
    div.className = "friend";
    div.dataset.friendId = f.friend.id;

    const initials = f.friend.username.substring(0, 2).toUpperCase();

    div.innerHTML = `  
<div class="friend-avatar">  
${initials}  
<div class="status-dot"></div>  
</div>  
<div class="friend-info">  
<div class="friend-name">${escapeHtml(f.friend.username)}</div>  
<div class="friend-last-message">Click to start chatting</div>  
</div>  
`;

    div.onclick = () => openChat(f.friend.id, f.friend.username);
    friendsList.appendChild(div);

    friendElements.push({ friendId: f.friend.id, element: div });
  }

  await Promise.all(
    friendElements.map(({ friendId, element }) =>
      checkOnlineStatus(friendId, element)
    )
  );
}

async function checkOnlineStatus(userId, element) {
  try {
    const data = await graphql(`  
query { getLastOnline(userId: "${userId}") { isOnline lastOnline } }  
`);
    if (data.getLastOnline.isOnline) {
      element.classList.add("online");
    }
  } catch (e) { }
}

async function openChat(friendId, username) {
  currentFriendId = friendId;
  currentFriendUsername = username;

  document.getElementById("chatTitle").textContent = username;
  document.getElementById("callBtn").disabled = false;
  document.getElementById("videoCallBtn").disabled = false;
  document.getElementById("screenShareBtn").disabled = false;
  document.getElementById("messageInput").disabled = false;
  document.getElementById("sendBtn").disabled = false;

  const messagesList = document.getElementById("messagesList");
  messagesList.innerHTML = "";
  selectedMessageId = null;
  selectedMessage = null;
  endCursor = null;
  hasNextPage = false;

  document
    .querySelectorAll(".friend")
    .forEach((el) => el.classList.remove("active"));
  document
    .querySelector(`[data-friend-id="${friendId}"]`)
    ?.classList.add("active");

  const data = await graphql(`  
mutation { createConversation(participantId: "${friendId}") { id } }  
`);
  currentConversationId = data.createConversation.id;
  allConversations.set(friendId, currentConversationId);

  const cachedMessages = CacheManager.loadMessages(currentConversationId);
  if (cachedMessages && cachedMessages.length > 0) {
    cachedMessages.forEach((msg) => displayMessage(msg));
  }

  await Promise.all([
    loadMessages(),
    markAsRead(),
    updateOnlineStatus(),
    updateLastOnline()
  ]);

  setupScrollListener();
  setupWebSocket();
  setInterval(updateLastOnline, 120000);
}

function setupScrollListener() {
  const container = document.getElementById("messagesContainer");

  container.addEventListener("scroll", async () => {
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;

    const isNearTop =
      Math.abs(scrollTop) >= scrollHeight - clientHeight - 100;

    if (isNearTop && hasNextPage && !isLoadingMore) {
      isLoadingMore = true;

      const loadingIndicator =
        document.getElementById("loadingIndicator");
      loadingIndicator.classList.add("show");

      const oldScrollHeight = container.scrollHeight;

      await loadMessages(endCursor);

      setTimeout(() => {
        const newScrollHeight = container.scrollHeight;
        const scrollDiff = newScrollHeight - oldScrollHeight;
        container.scrollTop = scrollTop - scrollDiff;

        loadingIndicator.classList.remove("show");
        isLoadingMore = false;
      }, 100);
    }
  });
}

async function loadMessages(cursor = null) {
  const data = await graphql(`  
query {  
fetchMessages(conversationId: "${currentConversationId}", cursor: ${cursor ? '"' + cursor + '"' : "null"}, limit: 20) {  
edges {  
cursor  
node {  
id  
conversationId  
senderId  
recipientId  
content  
timeSent  
meta {  
isUnsent  
isForwarded  
replyTo  
lastEditAt  
}  
reactions {  
userId  
type  
}  
repliedMessage {  
id  
content  
senderId  
}  
}  
}  
pageInfo {  
hasNextPage  
endCursor  
}  
}  
}  
`);

  endCursor = data.fetchMessages.pageInfo.endCursor;
  hasNextPage = data.fetchMessages.pageInfo.hasNextPage;

  const messages = data.fetchMessages.edges.map((e) => e.node);

  if (cursor) {
    messages.reverse().forEach((msg) => {
      prependMessage(msg);
    });
  } else {
    messages.reverse().forEach((msg) => {
      displayMessage(msg);
    });

    CacheManager.saveMessages(currentConversationId, messages);
  }
}

function displayMessage(msg) {
  const messagesList = document.getElementById("messagesList");
  const existingMsg = document.getElementById("msg-" + msg.id);

  const emptyState = messagesList.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  if (existingMsg) {
    const newElement = createMessageElement(msg);
    existingMsg.replaceWith(newElement);
    return;
  }

  const div = createMessageElement(msg);
  messagesList.appendChild(div);
}

function prependMessage(msg) {
  const messagesList = document.getElementById("messagesList");
  const existingMsg = document.getElementById("msg-" + msg.id);

  if (existingMsg) return;

  const div = createMessageElement(msg);
  messagesList.insertBefore(div, messagesList.firstChild);
}

function createMessageElement(msg) {
  const isMine = msg.senderId === myUserId;
  const div = document.createElement("div");
  div.className = `message ${isMine ? "sent" : "received"}`;
  div.id = "msg-" + msg.id;
  div.dataset.messageId = msg.id;

  if (msg.meta.isUnsent) div.classList.add("unsent");
  if (msg.meta.lastEditAt) div.classList.add("edited");
  if (msg.meta.isForwarded) div.classList.add("forwarded");

  let bubbleHTML = '<div class="message-bubble">';

  if (msg.meta.replyTo && msg.repliedMessage) {
    const replyContent = msg.repliedMessage.content || "[unsent]";
    bubbleHTML += `<div class="reply-preview">${escapeHtml(replyContent.substring(0, 50))}</div>`;
  }

  const content = msg.content || "[Message unsent]";
  bubbleHTML += `<div class="message-content">${escapeHtml(content)}</div>`;
  bubbleHTML += "</div>";

  if (msg.reactions.length > 0) {
    bubbleHTML += '<div class="reactions">';
    const reactionCounts = {};
    msg.reactions.forEach((r) => {
      reactionCounts[r.type] = (reactionCounts[r.type] || 0) + 1;
    });
    Object.entries(reactionCounts).forEach(([type, count]) => {
      bubbleHTML += `<span class="reaction">${REACTION_EMOJIS[type]} ${count}</span>`;
    });
    bubbleHTML += "</div>";
  }

  div.innerHTML = bubbleHTML;

  const actions = createMessageActions(msg);
  div.appendChild(actions);

  setupMessageHoverBehavior(div, msg);

  return div;
}

function createMessageActions(msg) {
  const isMine = msg.senderId === myUserId;
  const isUnsent = msg.meta.isUnsent;

  const actionsDiv = document.createElement("div");
  actionsDiv.className = "message-actions";

  const reactionBtn = document.createElement("button");
  reactionBtn.className = "action-btn";
  reactionBtn.innerHTML = "😊";
  reactionBtn.title = "React";
  reactionBtn.onclick = (e) => {
    e.stopPropagation();
    toggleReactionPicker(msg.id);
  };
  if (!isUnsent) actionsDiv.appendChild(reactionBtn);

  const reactionPicker = document.createElement("div");
  reactionPicker.className = "reaction-picker";
  reactionPicker.id = "reaction-picker-" + msg.id;

  const reactions = [
    { emoji: "", type: 1 },
    { emoji: "", type: 2 },
    { emoji: "", type: 3 },
    { emoji: "", type: 4 },
    { emoji: "", type: 5 },
    { emoji: "", type: 6 },
  ];

  reactions.forEach((r) => {
    const btn = document.createElement("button");
    btn.className = "reaction-option";
    btn.innerHTML = r.emoji;
    btn.onclick = (e) => {
      e.stopPropagation();
      addReaction(msg.id, r.type);
      closeReactionPicker();
    };
    reactionPicker.appendChild(btn);
  });

  actionsDiv.appendChild(reactionPicker);

  if (!isUnsent) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "action-btn";
    replyBtn.innerHTML = "↪️";
    replyBtn.title = "Reply";
    replyBtn.onclick = (e) => {
      e.stopPropagation();
      startReply(msg);
    };
    actionsDiv.appendChild(replyBtn);
  }

  const menuBtn = document.createElement("button");
  menuBtn.className = "action-btn";
  menuBtn.innerHTML = "⋯";
  menuBtn.title = "More";
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    toggleMessageMenu(msg);
  };
  actionsDiv.appendChild(menuBtn);

  const menu = document.createElement("div");
  menu.className = "message-menu";
  menu.id = "menu-" + msg.id;

  if (!isUnsent) {
    const forwardItem = document.createElement("div");
    forwardItem.className = "menu-item";
    forwardItem.innerHTML = "↖️ Forward";
    forwardItem.onclick = (e) => {
      e.stopPropagation();
      selectedMessage = msg;
      selectedMessageId = msg.id;
      openForwardModal();
      closeMessageMenu();
    };
    menu.appendChild(forwardItem);
  }

  if (isMine && !isUnsent) {
    const editItem = document.createElement("div");
    editItem.className = "menu-item";
    editItem.innerHTML = "✒️ Edit";
    editItem.onclick = (e) => {
      e.stopPropagation();
      editMessage(msg);
      closeMessageMenu();
    };
    menu.appendChild(editItem);
  }

  if (isMine && !isUnsent) {
    const unsendItem = document.createElement("div");
    unsendItem.className = "menu-item";
    unsendItem.innerHTML = "🫥 Unsend";
    unsendItem.onclick = (e) => {
      e.stopPropagation();
      unsendMessage(msg);
      closeMessageMenu();
    };
    menu.appendChild(unsendItem);
  }

  actionsDiv.appendChild(menu);

  return actionsDiv;
}

function setupMessageHoverBehavior(messageElement, msg) {
  const actions = messageElement.querySelector(".message-actions");
  const TOLERANCE_BUFFER = 80;
  const HIDE_DELAY = 400;

  function getElementBounds(element) {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top - TOLERANCE_BUFFER,
      bottom: rect.bottom + TOLERANCE_BUFFER,
      left: rect.left - TOLERANCE_BUFFER,
      right: rect.right + TOLERANCE_BUFFER,
    };
  }

  function isMouseInTolerance(mouseX, mouseY, bounds) {
    return (
      mouseX >= bounds.left &&
      mouseX <= bounds.right &&
      mouseY >= bounds.top &&
      mouseY <= bounds.bottom
    );
  }

  function isReactionPickerOpen() {
    const picker = document.getElementById("reaction-picker-" + msg.id);
    return picker && picker.classList.contains("show");
  }

  function showActions() {
    if (activeMessageHideTimeout) {
      clearTimeout(activeMessageHideTimeout);
      activeMessageHideTimeout = null;
    }

    if (activeMessageActions && activeMessageActions !== actions) {
      activeMessageActions.classList.remove("visible");
    }

    actions.classList.add("visible");
    activeMessageActions = actions;
  }

  function scheduleHide() {
    if (isReactionPickerOpen()) {
      return;
    }

    if (activeMessageHideTimeout) {
      clearTimeout(activeMessageHideTimeout);
    }

    activeMessageHideTimeout = setTimeout(() => {
      if (isReactionPickerOpen()) {
        return;
      }

      actions.classList.remove("visible");

      if (activeMessageActions === actions) {
        activeMessageActions = null;
      }
      activeMessageHideTimeout = null;
    }, HIDE_DELAY);
  }

  messageElement.addEventListener("mouseenter", (e) => {
    showActions();
  });

  messageElement.addEventListener("mousemove", (e) => {
    const bounds = getElementBounds(messageElement);
    const actionsBounds = getElementBounds(actions);

    if (
      isMouseInTolerance(e.clientX, e.clientY, bounds) ||
      isMouseInTolerance(e.clientX, e.clientY, actionsBounds)
    ) {
      showActions();
    }
  });

  messageElement.addEventListener("mouseleave", (e) => {
    const bounds = getElementBounds(messageElement);
    const actionsBounds = getElementBounds(actions);

    if (
      !isMouseInTolerance(e.clientX, e.clientY, bounds) &&
      !isMouseInTolerance(e.clientX, e.clientY, actionsBounds)
    ) {
      scheduleHide();
    }
  });

  actions.addEventListener("mouseenter", () => {
    showActions();
  });

  actions.addEventListener("mouseleave", () => {
    scheduleHide();
  });

  const reactionPicker = document.getElementById("reaction-picker-" + msg.id);
  if (reactionPicker) {
    reactionPicker.addEventListener("mouseenter", () => {
      showActions();
    });

    reactionPicker.addEventListener("mouseleave", () => {
      scheduleHide();
    });
  }

  document.addEventListener("mousemove", (e) => {
    if (!actions.classList.contains("visible")) return;

    const messageBounds = getElementBounds(messageElement);
    const actionsBounds = getElementBounds(actions);

    let isOverPicker = false;
    if (isReactionPickerOpen()) {
      const picker = document.getElementById("reaction-picker-" + msg.id);
      const pickerBounds = getElementBounds(picker);
      isOverPicker = isMouseInTolerance(e.clientX, e.clientY, pickerBounds);
    }

    if (
      !isMouseInTolerance(e.clientX, e.clientY, messageBounds) &&
      !isMouseInTolerance(e.clientX, e.clientY, actionsBounds) &&
      !isOverPicker
    ) {
      scheduleHide();
    }
  });
}

function toggleReactionPicker(messageId) {
  closeMessageMenu();

  const picker = document.getElementById("reaction-picker-" + messageId);

  if (activeReactionPicker && activeReactionPicker !== picker) {
    activeReactionPicker.classList.remove("show");
  }

  picker.classList.toggle("show");
  activeReactionPicker = picker.classList.contains("show")
    ? picker
    : null;
}

function closeReactionPicker() {
  if (activeReactionPicker) {
    activeReactionPicker.classList.remove("show");
    activeReactionPicker = null;
  }
}

function toggleMessageMenu(msg) {
  closeReactionPicker();

  const menu = document.getElementById("menu-" + msg.id);

  if (activeMenu && activeMenu !== menu) {
    activeMenu.classList.remove("show");
  }

  menu.classList.toggle("show");
  activeMenu = menu.classList.contains("show") ? menu : null;
}

function closeMessageMenu() {
  if (activeMenu) {
    activeMenu.classList.remove("show");
    activeMenu = null;
  }
}

document.addEventListener("click", () => {
  closeReactionPicker();
  closeMessageMenu();
});

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage() {
  const input = document.getElementById("messageInput");
  const content = input.value.trim();
  if (!content || !currentConversationId) return;

  const escapedContent = content
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  try {
    input.value = "";
    clearTimeout(typingTimeout);
    await setTyping(false);

    if (replyingToMessage) {
      await graphql(`  
mutation {  
replyToMessage(  
conversationId: "${currentConversationId}",  
replyToMessageId: "${replyingToMessage.id}",  
content: "${escapedContent}"  
) { id }  
}  
`);
      cancelReply();
    } else {
      await graphql(`  
mutation {  
sendMessage(conversationId: "${currentConversationId}", content: "${escapedContent}") {  
id  
}  
}  
`);
    }
  } catch (e) { }
}

function startReply(msg) {
  replyingToMessage = msg;
  const replyDiv = document.getElementById("replyingTo");
  const replyText = document.getElementById("replyText");
  replyText.textContent = `Replying to: ${(msg.content || "[unsent]").substring(0, 50)}`;
  replyDiv.classList.add("show");
  document.getElementById("messageInput").focus();
  closeMessageMenu();
}

function cancelReply() {
  replyingToMessage = null;
  document.getElementById("replyingTo").classList.remove("show");
}

async function editMessage(msg) {
  const newContent = prompt("Edit message:", msg.content);
  if (!newContent) return;

  const escaped = newContent
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  await graphql(`  
mutation {  
editMessage(messageId: "${msg.id}", newContent: "${escaped}") {  
id  
}  
}  
`);

  CacheManager.updateMessageInCache(currentConversationId, {
    ...msg,
    content: newContent,
    meta: { ...msg.meta, lastEditAt: new Date().toISOString() },
  });
}

async function unsendMessage(msg) {
  if (!confirm("Unsend this message?")) return;

  await graphql(`  
mutation {  
unsendMessage(messageId: "${msg.id}") {  
id  
}  
}  
`);

  CacheManager.updateMessageInCache(currentConversationId, {
    ...msg,
    meta: { ...msg.meta, isUnsent: true },
  });
}

function openForwardModal() {
  const forwardList = document.getElementById("forwardList");
  forwardList.innerHTML = "";

  allFriends.forEach((f) => {
    if (f.friend.id === currentFriendId) return;

    const btn = document.createElement("button");
    btn.textContent = `Forward to ${f.friend.username}`;
    btn.onclick = async () => {
      await forwardToFriend(f.friend.id);
      closeForwardModal();
    };
    forwardList.appendChild(btn);
  });

  document.getElementById("modalOverlay").classList.add("show");
  document.getElementById("forwardModal").classList.add("show");
}

function closeForwardModal() {
  document.getElementById("modalOverlay").classList.remove("show");
  document.getElementById("forwardModal").classList.remove("show");
}

async function forwardToFriend(friendId) {
  const convData = await graphql(`  
mutation { createConversation(participantId: "${friendId}") { id } }  
`);
  const targetConvId = convData.createConversation.id;

  await graphql(`  
mutation {  
forwardMessage(messageId: "${selectedMessageId}", toConversationId: "${targetConvId}") {  
id  
}  
}  
`);

}

async function addReaction(messageId, type) {
  try {
    await graphql(`  
mutation {  
addReaction(messageId: "${messageId}", reactionType: ${type}) {  
id  
}  
}  
`);
  } catch (e) { }
}

async function markAsRead() {
  if (!currentConversationId) return;

  await graphql(`  
mutation {  
markAsRead(conversationId: "${currentConversationId}") {  
conversationId  
}  
}  
`);
}

async function setTyping(isTyping) {
  if (!currentConversationId) return;

  await graphql(`  
mutation {  
setTyping(conversationId: "${currentConversationId}", isTyping: ${isTyping})  
}  
`);
}

async function updateOnlineStatus() {
  if (!currentFriendId) return;

  try {
    const data = await graphql(`  
query { getLastOnline(userId: "${currentFriendId}") { isOnline lastOnline} }  
`);

    const statusDiv = document.getElementById("onlineStatus");
    if (data.getLastOnline.isOnline) {
      statusDiv.textContent = "Active now";
      statusDiv.style.color = "#31a24c";
    } else {
      const lastSeen = new Date(
        data.getLastOnline.lastOnline,
      ).toLocaleString();
      statusDiv.textContent = `Last seen ${lastSeen}`;
      statusDiv.style.color = "#65676b";
    }
  } catch (e) { }
}

async function updateLastOnline() {
  try {
    await graphql(`  
      mutation {  
        updateLastOnline {  
          id  
        }  
      }  
    `);
  } catch (e) { }
}

function setupWebSocket() {
  if (ws) return;

  ws = new WebSocket(WS_URL, "graphql-transport-ws");

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "connection_init" }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "connection_ack") {
      if (currentConversationId) {
        subscribeToMessages();
        subscribeToMessageUpdates();
        subscribeToReactions();
        subscribeToReadStatus();
        subscribeToTyping();
      }

      subscribeToIncomingCalls();
    }

    if (msg.type === "next") {
      if (msg.payload && msg.payload.data) {
        handleSubscriptionData(msg.payload.data);
      }
    }
  };

  ws.onerror = () => { };
  ws.onclose = () => {
    ws = null;
    setTimeout(() => {
      if (!ws) setupWebSocket();
    }, 3000);
  };
}

function subscribe(query) {
  const id = String(subscriptionId++);
  ws.send(
    JSON.stringify({
      id,
      type: "subscribe",
      payload: { query },
    }),
  );
  return id;
}

function subscribeToMessages() {
  subscribe(`  
subscription {  
messageReceived(conversationId: "${currentConversationId}") {  
id conversationId senderId recipientId content timeSent  
meta { isUnsent isForwarded replyTo lastEditAt }  
reactions { userId type }  
repliedMessage { id content senderId }  
}  
}  
`);
}

function subscribeToMessageUpdates() {
  subscribe(`  
subscription {  
messageUpdated(conversationId: "${currentConversationId}") {  
id content  
meta { isUnsent lastEditAt }  
}  
}  
`);
}

function subscribeToReactions() {
  subscribe(`  
subscription {  
reactionUpdated(conversationId: "${currentConversationId}") {  
messageId  
}  
}  
`);
}

function subscribeToReadStatus() {
  subscribe(`  
subscription {  
readStatusChanged(conversationId: "${currentConversationId}") {  
conversationId userId timestamp  
}  
}  
`);
}

function subscribeToTyping() {
  subscribe(`  
subscription {  
typingIndicator(conversationId: "${currentConversationId}") {  
conversationId userId isTyping  
}  
}  
`);
}

function subscribeToIncomingCalls() {
  subscribe(`  
subscription {  
incomingCall {  
call { id type status startTime participantIds }  
caller { id username }  
}  
}  
`);
}

function subscribeToCallSignals(callId) {
  subscribe(`  
subscription {  
callSignal(callId: "${callId}") {  
callId senderId type payload  
}  
}  
`);
}

function subscribeToCallState(callId) {
  subscribe(`  
subscription {  
callStateChanged(callId: "${callId}") {  
callId status timestamp  
}  
}  
`);
}

async function initiateCall(callType) {
  if (!currentFriendId) {
    return;
  }

  try {
    const data = await graphql(`  
mutation {  
initiateCall(recipientId: "${currentFriendId}", callType: ${callType}) {  
success message  
call { id type status participantIds }  
stunServers { urls }  
}  
}  
`);

    if (!data.initiateCall.success) {
      return;
    }

    callCurrentCallId = data.initiateCall.call.id;
    callCurrentCallType = callType;
    callIsInitiator = true;
    callStunServers = data.initiateCall.stunServers.urls;

    updateCallStatus("Ringing...");

    subscribeToCallSignals(callCurrentCallId);
    subscribeToCallState(callCurrentCallId);

    await setupLocalMedia(callType);
    setupPeerConnection();

    showActiveCallUI();
  } catch (err) {
  }
}

async function handleIncomingCall(notification) {
  const { call, caller } = notification;

  callCurrentCallId = call.id;
  callCurrentCallType = call.type;
  callIsInitiator = false;

  subscribeToCallState(callCurrentCallId);

  document.getElementById("incomingCallerName").textContent = caller.username;
  document.getElementById("incomingCallType").textContent =
    call.type.toUpperCase() + " CALL";

  document.getElementById("incomingCallOverlay").classList.add("show");
  document.body.classList.add('call-active');
}

async function answerCall() {
  document.getElementById("incomingCallOverlay").classList.remove("show");
  updateCallStatus("Answering...");

  try {
    subscribeToCallSignals(callCurrentCallId);

    const data = await graphql(`  
mutation {  
answerCall(callId: "${callCurrentCallId}") {  
success message  
call { id type status }  
stunServers { urls }  
}  
}  
`);

    if (!data.answerCall.success) {
      document.body.classList.remove('call-active');
      return;
    }

    callStunServers = data.answerCall.stunServers.urls;
    updateCallStatus("Setting up media...");

    await setupLocalMedia(callCurrentCallType);
    setupPeerConnection();

    updateCallStatus("Waiting for offer...");
    showActiveCallUI();
  } catch (err) {
    callCleanup();
  }
}

async function rejectCall() {
  document.getElementById("incomingCallOverlay").classList.remove("show");

  try {
    await graphql(`mutation { rejectCall(callId: "${callCurrentCallId}") }`);
  } catch (err) { }

  callResetState();
}

async function setupLocalMedia(callType) {
  try {
    if (callType === "voice") {
      callLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } else if (callType === "video") {
      callLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      document.getElementById("toggleVideoBtn").style.display = "flex";
    } else if (callType === "screen") {
      callLocalStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    }

    document.getElementById("localVideo").srcObject = callLocalStream;
  } catch (err) {

    document.body.classList.remove('call-active');
    throw err;
  }
}

function setupPeerConnection() {
  const config = {
    iceServers:
      callStunServers.length > 0
        ? callStunServers.map((url) => ({ urls: url }))
        : [{ urls: "stun:stun.l.google.com:19302" }],
  };

  callPeerConnection = new RTCPeerConnection(config);

  if (callLocalStream) {
    callLocalStream.getTracks().forEach((track) => {
      callPeerConnection.addTrack(track, callLocalStream);
    });
  }

  callPeerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendICECandidate(event.candidate);
    }
  };

  callRemoteStream = new MediaStream();
  document.getElementById("remoteVideo").srcObject = callRemoteStream;

  callPeerConnection.ontrack = (event) => {
    callRemoteStream.addTrack(event.track);
  };

  callPeerConnection.onconnectionstatechange = () => {
    if (callPeerConnection.connectionState === "connected") {
      updateCallStatus("Connected");
    } else if (callPeerConnection.connectionState === "disconnected") {
      updateCallStatus("Disconnected");
    } else if (callPeerConnection.connectionState === "failed") {
      updateCallStatus("Connection failed");
      setTimeout(() => endCall(), 2000);
    }
  };
}

async function createAndSendOffer() {
  try {
    const offer = await callPeerConnection.createOffer();
    await callPeerConnection.setLocalDescription(offer);

    const sdpPayload = JSON.stringify({
      type: offer.type,
      sdp: offer.sdp,
    })
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    await graphql(`  
mutation {  
sendSDPOffer(  
callId: "${callCurrentCallId}",  
sdp: "${sdpPayload}"  
)  
}  
`);
  } catch (err) { }
}

async function createAndSendAnswer() {
  try {
    const answer = await callPeerConnection.createAnswer();
    await callPeerConnection.setLocalDescription(answer);

    const sdpPayload = JSON.stringify({
      type: answer.type,
      sdp: answer.sdp,
    })
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    await graphql(`  
mutation {  
sendSDPAnswer(  
callId: "${callCurrentCallId}",  
sdp: "${sdpPayload}"  
)  
}  
`);

    await processQueuedCandidates();
  } catch (err) { }
}

async function processQueuedCandidates() {
  if (callPendingIceCandidates.length > 0) {
    for (const candidate of callPendingIceCandidates) {
      try {
        await callPeerConnection.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      } catch (err) { }
    }
    callPendingIceCandidates = [];
  }
}

async function sendICECandidate(candidate) {
  try {
    const candidatePayload = JSON.stringify({
      candidate: candidate.candidate,
      sdpMLineIndex: candidate.sdpMLineIndex,
      sdpMid: candidate.sdpMid,
    })
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    await graphql(`  
mutation {  
sendICECandidate(  
callId: "${callCurrentCallId}",  
candidate: "${candidatePayload}"  
)  
}  
`);
  } catch (err) { }
}

async function handleCallSignal(signal) {
  try {
    if (signal.type === "offer") {
      const sdp =
        typeof signal.payload === "string"
          ? JSON.parse(signal.payload)
          : signal.payload;

      await callPeerConnection.setRemoteDescription(
        new RTCSessionDescription(sdp),
      );
      await createAndSendAnswer();
    } else if (signal.type === "answer") {
      const sdp =
        typeof signal.payload === "string"
          ? JSON.parse(signal.payload)
          : signal.payload;

      await callPeerConnection.setRemoteDescription(
        new RTCSessionDescription(sdp),
      );
      await processQueuedCandidates();
    } else if (signal.type === "ice-candidate") {
      const candidate =
        typeof signal.payload === "string"
          ? JSON.parse(signal.payload)
          : signal.payload;

      if (!callPeerConnection || !callPeerConnection.remoteDescription) {
        callPendingIceCandidates.push(candidate);
        return;
      }

      try {
        await callPeerConnection.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      } catch (err) { }
    }
  } catch (err) { }
}

function handleCallStateChange(stateChange) {
  updateCallStatus(stateChange.status);

  if (stateChange.status === "active") {
    if (
      callIsInitiator &&
      callPeerConnection &&
      !callPeerConnection.localDescription
    ) {
      setTimeout(() => createAndSendOffer(), 200);
    }
  }

  if (["ended", "rejected", "missed"].includes(stateChange.status)) {
    callCleanup();
    callResetState();
  }
}

async function endCall() {
  if (callCurrentCallId) {
    try {
      await graphql(`mutation { endCall(callId: "${callCurrentCallId}") }`);
    } catch (err) { }
  }

  callCleanup();
  callResetState();
}

function callCleanup() {
  if (callLocalStream) {
    callLocalStream.getTracks().forEach((track) => track.stop());
    callLocalStream = null;
  }

  if (callPeerConnection) {
    callPeerConnection.close();
    callPeerConnection = null;
  }

  callRemoteStream = null;

  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
}

function callResetState() {
  callCurrentCallId = null;
  callCurrentCallType = null;
  callIsInitiator = false;
  callStunServers = [];
  callPendingIceCandidates = [];
  callIsMuted = false;
  callIsVideoOff = false;

  updateCallStatus("Idle");

  document.getElementById("activeCallOverlay").classList.remove("show");
  document.getElementById("incomingCallOverlay").classList.remove("show");
  document.getElementById("toggleVideoBtn").style.display = "none";

  document.body.classList.remove('call-active');
}

function showActiveCallUI() {
  const overlay = document.getElementById("activeCallOverlay");
  overlay.classList.add("show");

  const username = currentFriendUsername || "Unknown";
  document.getElementById("activeCallUsername").textContent = username;

  const videoContainer = document.getElementById("callVideoContainer");
  if (callCurrentCallType === "voice") {
    videoContainer.style.display = "none";
  } else {
    videoContainer.style.display = "block";
  }

  document.body.classList.add('call-active');
}

function updateCallStatus(status) {
  const statusElement = document.getElementById("activeCallStatus");
  if (statusElement) {
    statusElement.textContent = status;
  }
}

function toggleMute() {
  if (!callLocalStream) return;

  const audioTrack = callLocalStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    callIsMuted = !audioTrack.enabled;

    const muteIcon = document.getElementById("muteIcon");
    muteIcon.textContent = callIsMuted ? "" : "";
  }
}

function toggleVideo() {
  if (!callLocalStream) return;

  const videoTrack = callLocalStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    callIsVideoOff = !videoTrack.enabled;

    const videoIcon = document.getElementById("videoIcon");
    videoIcon.textContent = callIsVideoOff ? "" : "";
  }
}

function minimizeCall() {
  const overlay = document.getElementById("activeCallOverlay");
  overlay.classList.toggle("minimized");
  callIsMinimized = !callIsMinimized;
}

function handleSubscriptionData(data) {
  if (data.messageReceived) {
    displayMessage(data.messageReceived);

    CacheManager.addMessageToCache(
      currentConversationId,
      data.messageReceived,
    );

    const container = document.getElementById("messagesContainer");
    container.scrollTop = 0;
  }

  if (data.messageUpdated) {
    updateMessageInUI(data.messageUpdated);

    CacheManager.updateMessageInCache(
      currentConversationId,
      data.messageUpdated,
    );
  }

  if (data.reactionUpdated) {
    updateReactionsInUI(data.reactionUpdated);
  }

  if (data.typingIndicator) {
    if (data.typingIndicator.userId !== myUserId) {
      const indicator = document.getElementById("typingIndicator");
      if (data.typingIndicator.isTyping) {
        indicator.textContent = `${currentFriendUsername} is typing...`;
      } else {
        indicator.textContent = "";
      }
    }
  }

  if (data.incomingCall) {
    handleIncomingCall(data.incomingCall);
  }

  if (data.callSignal) {
    handleCallSignal(data.callSignal);
  }

  if (data.callStateChanged) {
    handleCallStateChange(data.callStateChanged);
  }
}

function updateMessageInUI(msg) {
  const element = document.getElementById("msg-" + msg.id);
  if (!element) return;

  const cachedMessages = CacheManager.loadMessages(currentConversationId);
  if (cachedMessages) {
    const fullMsg = cachedMessages.find(m => m.id === msg.id);
    if (fullMsg) {
      const updatedMsg = { ...fullMsg, ...msg };
      const newElement = createMessageElement(updatedMsg);
      element.replaceWith(newElement);
      return;
    }
  }

  graphql(`  
query {  
fetchMessages(conversationId: "${currentConversationId}", limit: 100) {  
edges {  
node {  
id  
conversationId  
senderId  
recipientId  
content  
timeSent  
meta {  
isUnsent  
isForwarded  
replyTo  
lastEditAt  
}  
reactions {  
userId  
type  
}  
repliedMessage {  
id  
content  
senderId  
}  
}  
}  
}  
}  
`).then((result) => {
    const fullMsg = result.fetchMessages.edges.find(
      (e) => e.node.id === msg.id,
    );
    if (fullMsg) {
      const newElement = createMessageElement(fullMsg.node);
      element.replaceWith(newElement);
    }
  });
}

function updateReactionsInUI(data) {
  const element = document.getElementById("msg-" + data.messageId);
  if (!element) return;

  const cachedMessages = CacheManager.loadMessages(currentConversationId);
  if (cachedMessages) {
    const fullMsg = cachedMessages.find(m => m.id === data.messageId);
    if (fullMsg) {
      const newElement = createMessageElement(fullMsg);
      element.replaceWith(newElement);
      return;
    }
  }

  graphql(`  
query {  
fetchMessages(conversationId: "${currentConversationId}", limit: 100) {  
edges {  
node {  
id  
conversationId  
senderId  
recipientId  
content  
timeSent  
meta {  
isUnsent  
isForwarded  
replyTo  
lastEditAt  
}  
reactions {  
userId  
type  
}  
repliedMessage {  
id  
content  
senderId  
}  
}  
}  
}  
}  
`).then((result) => {
    const fullMsg = result.fetchMessages.edges.find(
      (e) => e.node.id === data.messageId,
    );
    if (fullMsg) {
      const newElement = createMessageElement(fullMsg.node);
      element.replaceWith(newElement);
    }
  });
}

document.getElementById("sendBtn").onclick = sendMessage;

document.getElementById("messageInput").onkeypress = (e) => {
  if (e.key === "Enter") {
    sendMessage();
  }
};

document.getElementById("messageInput").oninput = async () => {
  if (!currentConversationId) return;

  clearTimeout(typingTimeout);

  const hasContent =
    document.getElementById("messageInput").value.trim().length > 0;

  if (hasContent) {
    await setTyping(true);

    typingTimeout = setTimeout(async () => {
      await setTyping(false);
    }, 3000);
  } else {
    await setTyping(false);
  }
};

document.getElementById("cancelReplyBtn").onclick = cancelReply;

document.getElementById("searchInput").oninput = (e) => {
  const searchTerm = e.target.value.toLowerCase();
  const friends = document.querySelectorAll(".friend");

  friends.forEach((friend) => {
    const name = friend
      .querySelector(".friend-name")
      .textContent.toLowerCase();
    if (name.includes(searchTerm)) {
      friend.style.display = "flex";
    } else {
      friend.style.display = "none";
    }
  });
};

document.getElementById("modalOverlay").onclick = (e) => {
  if (e.target === e.currentTarget) {
    closeForwardModal();
  }
};

document.getElementById("callBtn").onclick = () => initiateCall("voice");
document.getElementById("videoCallBtn").onclick = () => initiateCall("video");
document.getElementById("screenShareBtn").onclick = () => initiateCall("screen");
document.getElementById("answerCallBtn").onclick = answerCall;
document.getElementById("rejectCallBtn").onclick = rejectCall;
document.getElementById("endCallBtn").onclick = endCall;
document.getElementById("toggleMuteBtn").onclick = toggleMute;
document.getElementById("toggleVideoBtn").onclick = toggleVideo;
document.getElementById("minimizeCallBtn").onclick = minimizeCall;

(async () => {
  try {
    await loadMe();
    await loadFriends();
    await updateLastOnline();
    setupWebSocket();

    setInterval(async () => {
      if (currentFriendId) {
        await updateOnlineStatus();
      }
    }, 30000);
  } catch (error) {
  }
})();

function openUserInfoModal() {
  const modal = document.getElementById('userInfoModal');
  const overlay = document.getElementById('modalOverlay');
  const userIdDisplay = document.getElementById('userIdDisplay');

  const checkUserId = setInterval(() => {
    if (window.myUserId) {
      userIdDisplay.textContent = window.myUserId;
      clearInterval(checkUserId);
    }
  }, 100);

  overlay.classList.add('show');
  modal.style.display = 'block';
}

function closeUserInfoModal() {
  const modal = document.getElementById('userInfoModal');
  const overlay = document.getElementById('modalOverlay');

  modal.style.display = 'none';
  overlay.classList.remove('show');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('userInfoBtn').addEventListener('click', openUserInfoModal);
  document.getElementById('userInfoClose').addEventListener('click', closeUserInfoModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeUserInfoModal();
      closeForwardModal();
    }
  });
});

window.myUserId = null;