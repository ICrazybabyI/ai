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
  const [currentConversationId, setCurrentConversationId] = useState(() => {
    return localStorage.getItem('currentConversationId') || '';
  });
  const [currentHelper, setCurrentHelper] = useState(() => {
    return localStorage.getItem('currentHelper') || 'cisco';
  });
  const messagesEndRef = useRef(null);
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
    // Validate if stored userId is a valid UUID (36 characters)
    if (storedUserId && storedUserId.length === 36) {
      return storedUserId;
    }
    // Generate a new valid UUID if stored one is invalid
    const newUserId = generateUUID();
    localStorage.setItem('userId', newUserId);
    return newUserId;
  };

  // Initialize userIdRef with a valid UUID string
  const userIdRef = useRef(getValidUserId());

  // Save userId to localStorage
  useEffect(() => {
    localStorage.setItem('userId', userIdRef.current);
  }, []);

  // Set dark mode
  useEffect(() => {
    localStorage.setItem('darkMode', isDarkMode);
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);
  
  // Save current helper to localStorage
  useEffect(() => {
    localStorage.setItem('currentHelper', currentHelper);
  }, [currentHelper]);

  // WebSocket connection with retry mechanism
  useEffect(() => {
    let ws = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 2000; // 2 seconds
    let reconnectTimeoutId = null;

    // Connect to WebSocket
    const connect = () => {
      console.log(`Attempting to connect to WebSocket server at ${WS_URL}`);
      ws = new WebSocket(WS_URL);
      console.log('WebSocket instance created:', ws);

      ws.onopen = () => {
        console.log('WebSocket connected successfully!');
        setIsConnected(true);
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        
        // Get conversations
        console.log('Sending get_conversations request');
        ws.send(JSON.stringify({
          type: 'get_conversations',
          userId: userIdRef.current
        }));
        
        // Get messages for current conversation
        if (currentConversationId) {
          console.log('Sending get_messages request for conversation:', currentConversationId);
          ws.send(JSON.stringify({
            type: 'get_messages',
            conversationId: currentConversationId
          }));
        }
      };

      ws.onmessage = (event) => {
        console.log('WebSocket message received:', event);
        try {
          const data = JSON.parse(event.data);
          console.log('WebSocket message parsed:', data);

          switch (data.type) {
            case 'welcome':
              console.log('Welcome message from server:', data.message);
              break;
            case 'message':
              setMessages(prev => {
                // Check if message already exists to avoid duplicates
                const messageExists = prev.some(m => m.id === data.id);
                if (messageExists) {
                  return prev;
                }
                
                // Check if there's a temporary user message with the same content
                // This happens because of optimistic UI update
                const tempMessageIndex = prev.findIndex(m => 
                  m.role === 'user' && 
                  m.content === data.content && 
                  m.isStreaming === false &&
                  // Check if it's a recent message (within 5 seconds)
                  Math.abs(new Date(m.createdAt) - new Date(data.createdAt)) < 5000
                );
                
                if (tempMessageIndex >= 0) {
                  // Replace temporary message with server-generated one
                  const updatedMessages = [...prev];
                  updatedMessages[tempMessageIndex] = {
                    id: data.id,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    helper: data.helper || currentHelper,
                    createdAt: new Date(data.createdAt),
                    isStreaming: false
                  };
                  return updatedMessages;
                }
                
                // If no temporary message found, add as new message
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
                const existingMessageIndex = prev.findIndex(m => m.id === data.id);
                if (existingMessageIndex >= 0) {
                  const updatedMessages = [...prev];
                  updatedMessages[existingMessageIndex] = {
                    ...updatedMessages[existingMessageIndex],
                    content: data.content,
                    thinks: data.thinks || [],
                    isStreaming: data.isStreaming
                  };
                  return updatedMessages;
                } else {
                  // Check if this is a duplicate message by content
                  const isDuplicate = prev.some(m => 
                    m.content === data.content && 
                    m.role === data.role && 
                    m.conversationId === data.conversationId
                  );
                  if (isDuplicate) {
                    console.log('Skipping duplicate message:', data.id);
                    return prev;
                  }
                  return [...prev, {
                    id: data.id,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    thinks: data.thinks || [],
                    isStreaming: data.isStreaming,
                    createdAt: new Date(data.createdAt),
                    showThinks: false // Add showThinks state to control visibility
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
              setCurrentConversationId(data.conversationId);
              localStorage.setItem('currentConversationId', data.conversationId);
              setMessages([]);
              break;
            
            case 'error':
              console.error('WebSocket error message:', data.error);
              break;
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
          console.error('Raw message:', event.data);
        }
      };

      ws.onclose = (event) => {
        console.error('WebSocket disconnected:', event);
        console.error('Close code:', event.code);
        console.error('Close reason:', event.reason);
        console.error('Was clean close:', event.wasClean);
        setIsConnected(false);
        
        // Attempt to reconnect if we haven't reached max attempts
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts})...`);
          reconnectTimeoutId = setTimeout(connect, reconnectDelay);
        } else {
          console.error('Max reconnect attempts reached. Please refresh the page to reconnect.');
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error event:', error);
        console.error('Error type:', error.type);
        console.error('Error target:', error.target);
        // Don't close connection on error, let onclose handle reconnect
      };

      setWs(ws);
    };

    // Initial connection
    connect();

    // Cleanup function
    return () => {
      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
      }
      if (ws) {
        console.log('Closing WebSocket connection in cleanup');
        ws.close();
      }
    };
  }, []);

  // Scroll to bottom whenever messages change, including when sending new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message to WebSocket
  const sendMessage = useCallback(() => {
    if (!inputMessage.trim() || !ws || !isConnected) return;

    // Create a temporary message object for the user's message
    const userMessage = {
      id: generateUUID(),
      conversationId: currentConversationId,
      role: 'user',
      content: inputMessage,
      helper: currentHelper,
      createdAt: new Date(),
      isStreaming: false
    };

    // Add the message to local state immediately for better UX
    setMessages(prev => [...prev, userMessage]);

    ws.send(JSON.stringify({
      type: 'new_message',
      conversationId: currentConversationId,
      message: inputMessage,
      userId: userIdRef.current,
      helper: currentHelper
    }));

    setInputMessage('');
  }, [inputMessage, ws, isConnected, currentConversationId, currentHelper]);

  // Handle input change
  const handleInputChange = (e) => {
    setInputMessage(e.target.value);
  };

  // Handle key press (Enter to send, Shift+Enter for new line)
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Handle conversation change
  const handleConversationChange = (conversationId) => {
    setCurrentConversationId(conversationId);
    localStorage.setItem('currentConversationId', conversationId);
    setMessages([]);
    
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: 'get_messages',
        conversationId: conversationId
      }));
    }
  };

  // Create new conversation
  const createNewConversation = () => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: 'create_conversation',
        userId: userIdRef.current,
        title: `New Conversation ${new Date().toLocaleString()}`
      }));
    }
  };

  // Toggle dark mode
  const toggleDarkMode = () => {
    setIsDarkMode(!isDarkMode);
  };

  // State for delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Delete conversation
  const deleteConversation = (conversationId) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: 'delete_conversation',
        conversationId: conversationId,
        userId: userIdRef.current
      }));
      setDeleteConfirm(null);
      
      // If deleting current conversation, clear currentConversationId
      // The new conversation will be created if needed in the WebSocket message handler
      if (conversationId === currentConversationId) {
        setCurrentConversationId('');
        setMessages([]);
      }
    }
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
                  onClick={() => setCurrentHelper('network')}
                  title="切换到网络知识助手"
                >
                  思科配置助手
                </button>
              </div>
              <div className="helper-card back network-card">
                <button 
                  className="helper-toggle-btn"
                  onClick={() => setCurrentHelper('cisco')}
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
              <div className="messages-container">
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
                                // Auto-scroll when thinking is expanded and message is streaming
                                if (el && message.showThinks && message.isStreaming) {
                                  el.scrollTop = el.scrollHeight;
                                }
                              }}
                            >
                              {message.thinks.map((think, index) => (
                                <div key={index} className="think-item">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{think}</ReactMarkdown>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="message-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
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
