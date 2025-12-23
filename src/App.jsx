import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';
import aiAvatar from '../ai-avatar.png';
import aiAvatarWhite from '../ai-avatar_white.png';

// Use relative WebSocket URL with same port as HTTP server to avoid CORS issues
const WS_URL = window.location.protocol === 'https:' ? `wss://${window.location.host}` : `ws://${window.location.host}`;

function App() {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('darkMode') === 'true' ||
           window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [ws, setWs] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [conversations, setConversations] = useState([]);
  // currentConversationId is the active conversation id shown in UI
  const [currentConversationId, setCurrentConversationId] = useState('');
  // currentHelper: 'cisco' | 'network'
  const [currentHelper, setCurrentHelper] = useState(() => {
    return localStorage.getItem('currentHelper') || 'cisco';
  });

  // Map of helper -> conversationId, persisted in localStorage
  const [conversationMap, setConversationMap] = useState(() => {
    try {
      const raw = localStorage.getItem('conversationMap');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { cisco: '', network: '' };
  });

  // pending helper for which we requested create_conversation but haven't received conversation_created yet
  const pendingConversationCreateHelperRef = useRef(null);

  const messagesContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const autoScrollRef = useRef(true);
  const lastAutoScrollAtRef = useRef(0);
  const scrollThrottleMs = 80;
  const autoScrollThresholdPx = 150;
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);

  // Generate a compatible UUID
  const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  // Ensure userId is always a valid UUID
  const getValidUserId = () => {
    const storedUserId = localStorage.getItem('userId');
    if (storedUserId && storedUserId.length === 36) {
      return storedUserId;
    }
    const newUserId = generateUUID();
    localStorage.setItem('userId', newUserId);
    return newUserId;
  };

  const userIdRef = useRef(getValidUserId());

  // Persist conversationMap and currentHelper changes
  useEffect(() => {
    localStorage.setItem('conversationMap', JSON.stringify(conversationMap));
  }, [conversationMap]);

  useEffect(() => {
    localStorage.setItem('currentHelper', currentHelper);
  }, [currentHelper]);

  // initialize currentConversationId from conversationMap for the starting helper
  useEffect(() => {
    const mappedId = conversationMap[currentHelper];
    if (mappedId) {
      setCurrentConversationId(mappedId);
    } else {
      setCurrentConversationId(''); // no mapped conversation yet
    }
  }, []); // run once on mount

  // Save userId to localStorage (just ensure)
  useEffect(() => {
    localStorage.setItem('userId', userIdRef.current);
  }, []);

  // Set dark mode class on html root
  useEffect(() => {
    localStorage.setItem('darkMode', isDarkMode);
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  // WebSocket connection with retry mechanism
  useEffect(() => {
    let wsInstance = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 2000; // 2 seconds
    let reconnectTimeoutId = null;

    const connect = () => {
      console.log(`Attempting to connect to WebSocket server at ${WS_URL}`);
      wsInstance = new WebSocket(WS_URL);
      console.log('WebSocket instance created:', wsInstance);

      wsInstance.onopen = () => {
        console.log('WebSocket connected successfully!');
        setWs(wsInstance);
        setIsConnected(true);
        reconnectAttempts = 0;

        // Request conversations list
        wsInstance.send(JSON.stringify({
          type: 'get_conversations',
          userId: userIdRef.current
        }));

        // If we have an active conversation id for current helper, request its messages
        if (conversationMap[currentHelper]) {
          wsInstance.send(JSON.stringify({
            type: 'get_messages',
            conversationId: conversationMap[currentHelper]
          }));
        } else if (currentConversationId) {
          // fallback if currentConversationId set
          wsInstance.send(JSON.stringify({
            type: 'get_messages',
            conversationId: currentConversationId
          }));
        }
      };

      wsInstance.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'welcome':
              console.log('Welcome:', data.message);
              break;
            case 'message':
              setMessages(prev => {
                const messageExists = prev.some(m => m.id === data.id);
                if (messageExists) return prev;
                // optimistic replacement logic
                const tempMessageIndex = prev.findIndex(m =>
                  m.role === 'user' &&
                  m.content === data.content &&
                  m.isStreaming === false &&
                  Math.abs(new Date(m.createdAt) - new Date(data.createdAt)) < 5000
                );
                if (tempMessageIndex >= 0) {
                  const updated = [...prev];
                  updated[tempMessageIndex] = {
                    id: data.id,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    helper: data.helper || currentHelper,
                    createdAt: new Date(data.createdAt),
                    isStreaming: false
                  };
                  return updated;
                }
                return [...prev, {
                  id: data.id,
                  conversationId: data.conversationId,
                  role: data.role,
                  content: data.content,
                  helper: data.helper || currentHelper,
                  createdAt: new Date(data.createdAt)
                }];
              });
              break;

            case 'streaming_message':
              setMessages(prev => {
                const idx = prev.findIndex(m => m.id === data.id);
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = {
                    ...updated[idx],
                    content: data.content,
                    thinks: data.thinks || [],
                    isStreaming: data.isStreaming
                  };
                  return updated;
                } else {
                  const duplicate = prev.some(m =>
                    m.content === data.content &&
                    m.role === data.role &&
                    m.conversationId === data.conversationId
                  );
                  if (duplicate) return prev;
                  return [...prev, {
                    id: data.id,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    thinks: data.thinks || [],
                    isStreaming: data.isStreaming,
                    createdAt: new Date(data.createdAt),
                    showThinks: false
                  }];
                }
              });
              setIsTyping(data.isStreaming);
              break;

            case 'conversations':
              setConversations(data.conversations);
              break;

            case 'messages':
              setMessages(data.messages.map(msg => ({
                id: msg.id,
                conversationId: msg.conversationId,
                role: msg.role,
                content: msg.content,
                helper: msg.helper,
                thinks: msg.thinks || [],
                isStreaming: false,
                createdAt: new Date(msg.createdAt),
                showThinks: false
              })));
              break;

            case 'conversation_created':
              {
                const newConversationId = data.conversationId;
                // assign to pending helper if exists, otherwise assign to currentHelper
                const helperToAssign = pendingConversationCreateHelperRef.current || currentHelper;

                setConversationMap(prev => {
                  const updated = { ...prev, [helperToAssign]: newConversationId };
                  localStorage.setItem('conversationMap', JSON.stringify(updated));
                  return updated;
                });

                setCurrentConversationId(newConversationId);
                localStorage.setItem('currentConversationId', newConversationId);

                // Clear pending helper
                pendingConversationCreateHelperRef.current = null;

                // clear messages in UI for new conversation
                setMessages([]);
              }
              break;

            case 'error':
              console.error('Server error:', data.error || data.message || data.details);
              break;

            default:
              console.log('Unknown message type:', data.type);
          }
        } catch (err) {
          console.error('Error parsing WS message:', err, event.data);
        }
      };

      wsInstance.onclose = (event) => {
        console.error('WebSocket disconnected:', event);
        setIsConnected(false);
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          reconnectTimeoutId = setTimeout(connect, reconnectDelay);
        } else {
          console.error('Max reconnect attempts reached.');
        }
      };

      wsInstance.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
      if (wsInstance) wsInstance.close();
    };
    // intentionally run once
  }, []);

  // If currentConversationId changes after websocket connected, fetch messages
  useEffect(() => {
    if (ws && isConnected && currentConversationId) {
      ws.send(JSON.stringify({
        type: 'get_messages',
        conversationId: currentConversationId
      }));
    }
  }, [currentConversationId, ws, isConnected]);

  // Scroll listener: track whether user is near bottom and update state/ref
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    let rafId = null;
    const onScroll = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) <= autoScrollThresholdPx;
        autoScrollRef.current = atBottom;
        setIsUserAtBottom(atBottom);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

    const scrollToBottom = useCallback(() => {
      const el = messagesContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll effect: run on messages / typing
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (!autoScrollRef.current) return;

    const lastMsg = messages[messages.length - 1];
    const streamingNow = isTyping || (lastMsg && lastMsg.isStreaming);

    const now = Date.now();
    if (streamingNow) {
      if (now - lastAutoScrollAtRef.current > scrollThrottleMs) {
        lastAutoScrollAtRef.current = now;
        scrollToBottom('auto');
      }
    } else {
      scrollToBottom('smooth');
    }
  }, [messages, isTyping, scrollToBottom]);

  // When conversation changes / messages reset, enable auto-scroll
  useEffect(() => {
    autoScrollRef.current = true;
    setIsUserAtBottom(true);
    scrollToBottom('auto');
  }, [currentConversationId, scrollToBottom]);

  // Send message to WebSocket
  const sendMessage = useCallback(() => {
    if (!inputMessage.trim() || !ws || !isConnected) return;

    // determine conversation id to use (mapped for current helper if present)
    const convoIdToUse = conversationMap[currentHelper] || currentConversationId || '';

    const userMessage = {
      id: generateUUID(),
      conversationId: convoIdToUse,
      role: 'user',
      content: inputMessage,
      helper: currentHelper,
      createdAt: new Date(),
      isStreaming: false
    };

    // optimistic add
    setMessages(prev => [...prev, userMessage]);

    ws.send(JSON.stringify({
      type: 'new_message',
      conversationId: convoIdToUse,
      message: inputMessage,
      userId: userIdRef.current,
      helper: currentHelper
    }));

    setInputMessage('');
  }, [inputMessage, ws, isConnected, currentConversationId, conversationMap, currentHelper]);

  const handleInputChange = (e) => setInputMessage(e.target.value);
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // When user selects a conversation from sidebar, we should bind it to the active helper
  const handleConversationChange = (conversationId) => {
    setCurrentConversationId(conversationId);
    // bind to current helper
    setConversationMap(prev => {
      const updated = { ...prev, [currentHelper]: conversationId };
      localStorage.setItem('conversationMap', JSON.stringify(updated));
      return updated;
    });
    localStorage.setItem('currentConversationId', conversationId);
    setMessages([]);
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: 'get_messages',
        conversationId: conversationId
      }));
    }
  };

  // Create new conversation for current helper
  const createNewConversation = () => {
    if (ws && isConnected) {
      // mark pending helper
      pendingConversationCreateHelperRef.current = currentHelper;
      ws.send(JSON.stringify({
        type: 'create_conversation',
        userId: userIdRef.current,
        title: `New Conversation (${currentHelper}) ${new Date().toLocaleString()}`
      }));
    }
  };

  // Toggle dark mode
  const toggleDarkMode = () => {
    setIsDarkMode(!isDarkMode);
  };

  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const deleteConversation = (conversationId) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: 'delete_conversation',
        conversationId: conversationId,
        userId: userIdRef.current
      }));
      setDeleteConfirm(null);

      // If deleting current conversation, clear currentConversationId
      if (conversationId === currentConversationId) {
        setCurrentConversationId('');
        setMessages([]);
      }

      // Remove mapping entries that reference this conversationId
      setConversationMap(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => {
          if (updated[k] === conversationId) updated[k] = '';
        });
        localStorage.setItem('conversationMap', JSON.stringify(updated));
        return updated;
      });
    }
  };

  // Switching helper: reuse mapped conversationId if exists, otherwise create new conversation
  const switchHelper = (newHelper) => {
    // update UI helper immediately
    setCurrentHelper(newHelper);

    const mapped = conversationMap[newHelper];
    if (mapped) {
      // use existing conversation id for that helper
      setCurrentConversationId(mapped);
      localStorage.setItem('currentConversationId', mapped);
      setMessages([]);
      if (ws && isConnected) {
        ws.send(JSON.stringify({
          type: 'get_messages',
          conversationId: mapped
        }));
      }
    } else {
      // No mapped conversation: request create_conversation for this helper
      pendingConversationCreateHelperRef.current = newHelper;
      if (ws && isConnected) {
        ws.send(JSON.stringify({
          type: 'create_conversation',
          userId: userIdRef.current,
          title: `New Conversation (${newHelper}) ${new Date().toLocaleString()}`
        }));
      } else {
        // if no ws, just clear currentConversationId
        setCurrentConversationId('');
        setMessages([]);
      }
    }
  };

  // Unified Markdown component (GFM only)
  const Markdown = ({ children }) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {children}
    </ReactMarkdown>
  );

  const handleScrollToBottomClick = () => {
    autoScrollRef.current = true;
    setIsUserAtBottom(true);
    scrollToBottom('smooth');
  };

  return (
    <div className={`app ${isDarkMode ? 'dark' : ''}`}>
      <div className="app-container">
          {/* Floating helper toggle button with simple flip animation */}
          <div className="floating-helper-toggle">
            <div className={`helper-toggle-container ${currentHelper === 'network' ? 'flipped' : ''}`}>
              <div className="helper-card front cisco-card">
                <button 
                  className="helper-toggle-btn"
                  onClick={() => switchHelper('network')}
                  title="切换到网络知识助手"
                >
                  思科配置助手
                </button>
              </div>
              <div className="helper-card back network-card">
                <button 
                  className="helper-toggle-btn"
                  onClick={() => switchHelper('cisco')}
                  title="切换到思科配置助手"
                >
                  网络知识助手
                </button>
              </div>
            </div>
          </div>
        
        {/* Sidebar */}
        <div className="sidebar">
          <div className="sidebar-header">
            <h1>AI Chat</h1>
            <div className="sidebar-actions">
              <button 
                className="new-conversation-btn" 
                onClick={createNewConversation}
                title="New Conversation"
              >
                +
              </button>
              <button 
                className="theme-toggle-btn" 
                onClick={toggleDarkMode}
                title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {isDarkMode ? '☀️' : '🌙'}
              </button>
            </div>
          </div>
          
          <div className="conversations-list">
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversation-item ${conversation.id === currentConversationId ? 'active' : ''}`}
                onClick={() => handleConversationChange(conversation.id)}
              >
                <div className="conversation-title">
                  {conversation.title}
                </div>
                <div className="conversation-date">
                  {new Date(conversation.updated_at).toLocaleString()}
                  <div className="conversation-delete-container">
                    {deleteConfirm === conversation.id ? (
                      <>
                        <button 
                          className="delete-cancel-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm(null);
                          }}
                          title="Cancel Delete"
                        >
                          ⤸
                        </button>
                        <button 
                          className="delete-confirm-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteConversation(conversation.id);
                          }}
                          title="Confirm Delete"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button 
                        className="delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm(conversation.id);
                        }}
                        title="Delete Conversation"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main Chat Area */}
        <div className="chat-container">
          {currentConversationId ? (
            <>
              {/* Messages */}
              <div className="messages-container" ref={messagesContainerRef}>

                {/* "回到底部" 按钮（当用户非底部时显示） */}
                {!isUserAtBottom && (
                  <button
                    className="scroll-to-bottom"
                    onClick={handleScrollToBottomClick}
                    title="Scroll to bottom"
                  >
                    ⤓ 回到底部
                  </button>
                )}

                {messages.length === 0 && !isTyping ? (
                  <div className="empty-state">
                    <img 
                      src={isDarkMode ? aiAvatarWhite : aiAvatar} 
                      alt="AI Assistant" 
                      className="empty-state-image"
                    />
                    <p className="empty-state-text">我是AI小助手,请输入您的问题!</p>
                  </div>
                ) : (
                  <>
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`message ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                      >
                        {/* Helper indicator above the message */}
                        {message.helper && (
                          <div className="message-helper">
                            {message.helper === 'cisco' ? '思科配置助手' : '网络知识助手'}
                          </div>
                        )}
                        
                        {/* Think section with toggle for assistant messages */}
                        {message.role === 'assistant' && message.thinks && message.thinks.length > 0 && (
                          <div className="message-think-container">
                            <button 
                              className="think-toggle-btn"
                              onClick={() => {
                                setMessages(prev => {
                                  const updatedMessages = [...prev];
                                  const msgIndex = updatedMessages.findIndex(m => m.id === message.id);
                                  if (msgIndex >= 0) {
                                    updatedMessages[msgIndex] = {
                                      ...updatedMessages[msgIndex],
                                      showThinks: !updatedMessages[msgIndex].showThinks
                                    };
                                  }
                                  return updatedMessages;
                                });
                              }}
                              title={message.showThinks ? 'Hide thinking process' : 'Show thinking process'}
                            >
                              {message.showThinks ? '▼' : '▶'}
                            </button>
                            <div 
                              className={`message-think ${message.showThinks ? 'open' : ''}`}
                              ref={(el) => {
                                if (el && message.showThinks && message.isStreaming && autoScrollRef.current) {
                                  el.scrollTop = el.scrollHeight;
                                }
                              }}
                            >
                              {message.thinks.map((think, index) => (
                                <div key={index} className="think-item">
                                  <Markdown>{think}</Markdown>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="message-content">
                          <Markdown>{message.content}</Markdown>
                          {message.isStreaming && <span className="typing-indicator">...</span>}
                        </div>
                        <div className="message-time">
                          {message.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    ))}
                    {isTyping && (
                      <div className="message assistant typing">
                        <div className="message-content">
                          <div className="typing-dots">
                            <span></span>
                            <span></span>
                            <span></span>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="input-container">
                <textarea
                  className="message-input"
                  placeholder="Type your message... (Shift+Enter for new line)"
                  value={inputMessage}
                  onChange={handleInputChange}
                  onKeyPress={handleKeyPress}
                  disabled={!isConnected}
                  rows={1}
                />
                <button
                  className="send-btn"
                  onClick={sendMessage}
                  disabled={!inputMessage.trim() || !isConnected}
                  title="Send Message (Enter)"
                >
                  Send
                </button>
              </div>
            </>
          ) : (
            <div className="welcome-screen">
              <h2>Welcome to AI Chat</h2>
              <p>Start a new conversation to begin chatting with AI.</p>
              <button 
                className="start-conversation-btn" 
                onClick={createNewConversation}
              >
                New Conversation
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
