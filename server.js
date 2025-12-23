import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { WebSocketServer } from 'ws';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

// Set __dirname for ES modules
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

console.log('Loaded environment variables:');
console.log('PORT:', process.env.PORT);

const httpPort = process.env.PORT || 80;
console.log('Using HTTP port:', httpPort);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Handle root path by serving index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// HTTP API endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'HTTP Server is running' });
});

// Create HTTP server
const server = http.createServer(app);

// In-memory storage for testing without database
let inMemoryUsers = new Map();
let inMemoryConversations = new Map();
let inMemoryMessages = new Map();

// Database connection pool (optional)
let pool = null;
let databaseAvailable = false;

// Try to initialize database connection
async function initializeDatabase() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Test connection
    const connection = await pool.getConnection();

    // Create users table if not exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create conversations table if not exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        title VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        dify_conversation_id VARCHAR(100) NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create messages table if not exists (matching actual database structure)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(36) PRIMARY KEY,
        user VARCHAR(36) NULL,
        conversation_id VARCHAR(36) NOT NULL,
        query TEXT NOT NULL,
        answer TEXT NOT NULL,
        think TEXT NULL,
        helper VARCHAR(50) DEFAULT 'cisco' NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ai_update_at TIMESTAMP NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);

    // Compatibility-safe check: add helper column if missing
    try {
      const [helperColCheck] = await connection.query(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = 'messages'
           AND COLUMN_NAME = 'helper'`,
        [process.env.DB_NAME]
      );

      if (helperColCheck[0].cnt === 0) {
        await connection.query(
          "ALTER TABLE messages ADD COLUMN helper VARCHAR(50) DEFAULT 'cisco' NOT NULL"
        );
        console.log("Added 'helper' column to messages table.");
      } else {
        console.log("Helper column already exists, skipping.");
      }
    } catch (error) {
      console.error('Error checking/adding helper column:', error.message);
    }

    // Compatibility-safe check: add dify_conversation_id column if missing
    try {
      const [difyColCheck] = await connection.query(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = 'conversations'
           AND COLUMN_NAME = 'dify_conversation_id'`,
        [process.env.DB_NAME]
      );

      if (difyColCheck[0].cnt === 0) {
        await connection.query(
          "ALTER TABLE conversations ADD COLUMN dify_conversation_id VARCHAR(100) DEFAULT NULL"
        );
        console.log("Added 'dify_conversation_id' column to conversations table.");
      } else {
        console.log("dify_conversation_id column already exists, skipping.");
      }
    } catch (error) {
      console.error('Error checking/adding dify_conversation_id column:', error.message);
    }

    connection.release();
    databaseAvailable = true;
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    console.log('Using in-memory storage instead');
    databaseAvailable = false;
  }
}

// Mock AI response for testing when Dify API is not available
async function mockAIResponse(ws, conversationId, message, helper = 'cisco') {
  const assistantMessageId = uuidv4();
  const mockResponses = {
    '你好': '你好！我是一个AI助手，很高兴为您服务。',
    '今天天气怎么样': '抱歉，我无法获取实时天气信息，但您可以尝试使用天气应用或网站查询。',
    '你能做什么': '我可以帮助您回答问题、提供信息、进行对话等。',
    '谢谢': '不客气！如果您有任何其他问题，随时可以问我。'
  };

  const responseText = mockResponses[message] || `我收到了您的消息："${message}"。这是一个模拟的AI响应，因为Dify API调用失败了。`;

  let currentText = '';
  let firstMessageSent = false;

  for (const char of responseText) {
    currentText += char;
    ws.send(JSON.stringify({
      type: 'streaming_message',
      id: assistantMessageId,
      conversationId: conversationId,
      role: 'assistant',
      content: currentText,
      isStreaming: true,
      createdAt: new Date().toISOString()
    }));
    firstMessageSent = true;
    await new Promise(resolve => setTimeout(resolve, 30));
  }

  if (responseText && firstMessageSent) {
    ws.send(JSON.stringify({
      type: 'streaming_message',
      id: assistantMessageId,
      conversationId: conversationId,
      role: 'assistant',
      content: responseText,
      isStreaming: false,
      createdAt: new Date().toISOString()
    }));
  }

  if (databaseAvailable && pool) {
    try {
      await pool.query(
        'INSERT INTO messages (id, conversation_id, query, answer, helper) VALUES (?, ?, ?, ?, ?)',
        [assistantMessageId, conversationId, '', responseText, helper || 'cisco']
      );
    } catch (err) {
      console.warn('Failed to save mock response to DB:', err.message);
    }
  }
}

// Function to process AI response, extract think sections and clean content
function processAIResponse(response) {
  // Initialize variables
  const thinks = [];
  let mainContent = response;
  const uniqueThinks = new Set();

  // Extract all complete <think> sections with proper closing tags
  const completeThinkPattern = /<think>([\s\S]*?)<\/think>/g;
  let match;

  // First extract all complete think sections
  while ((match = completeThinkPattern.exec(response)) !== null) {
    const thinkContent = match[1].trim();
    if (thinkContent && !uniqueThinks.has(thinkContent)) {
      uniqueThinks.add(thinkContent);
      thinks.push(thinkContent);
    }
  }

  // Remove all complete think sections from main content
  mainContent = mainContent.replace(completeThinkPattern, '').trim();

  // Handle incomplete think sections (without closing tag) during streaming
  const incompleteThinkPattern = /<think>([\s\S]*)$/;
  const incompleteMatch = mainContent.match(incompleteThinkPattern);

  if (incompleteMatch) {
    const thinkContent = incompleteMatch[1].trim();
    if (thinkContent && !uniqueThinks.has(thinkContent)) {
      uniqueThinks.add(thinkContent);
      thinks.push(thinkContent);
    }
    mainContent = mainContent.replace(incompleteThinkPattern, '').trim();
  }

  // Clean up any remaining standalone think tags
  mainContent = mainContent.replace(/<think>/g, '').replace(/<\/think>/g, '').trim();

  return {
    thinks,
    mainContent
  };
}

// Call Dify API for streaming response (improved: reuse/persist dify_conversation_id)
async function callDifyAPI(ws, conversationId, message, userMessageId, helper) {
  try {
    const assistantMessageId = uuidv4();
    let fullResponse = '';

    const difyUrl = process.env.DIFY_API_URL;
    const apiKey = helper === 'network' ?
      process.env.DIFY_API_KEY_NETWORK || process.env.DIFY_API_KEY :
      process.env.DIFY_API_KEY;

    if (!difyUrl || !apiKey) {
      console.warn('DIFY API URL or API Key not configured, using mock response');
      await mockAIResponse(ws, conversationId, message, helper);
      return;
    }

    // 1) Try to get an existing dify_conversation_id from DB for this local conversationId
    let difyConversationId = null;
    try {
      if (databaseAvailable && pool && conversationId) {
        const [rows] = await pool.query(
          'SELECT dify_conversation_id FROM conversations WHERE id = ? LIMIT 1',
          [conversationId]
        );
        if (rows && rows[0] && rows[0].dify_conversation_id) {
          difyConversationId = rows[0].dify_conversation_id;
          console.log('Found existing dify_conversation_id for', conversationId, difyConversationId);
        }
      }
    } catch (err) {
      console.warn('Failed to read dify_conversation_id from DB:', err.message);
    }

    // 2) Prepare endpoints & headers
    const endpoints = [
      `${difyUrl}/v1/chat/completions`,
      `${difyUrl}/v1/chat-messages`,
      `${difyUrl}/api/chat-messages`
    ];
    const authHeaders = { 'Authorization': `Bearer ${apiKey}` };

    let response = null;
    let apiUrl = null;

    // 3) Try endpoints, always include conversation_id if we have one
    for (const endpoint of endpoints) {
      apiUrl = endpoint;
      try {
        const body = {
          inputs: {},
          query: message,
          response_mode: 'streaming',
          user: 'local-user'
        };
        if (difyConversationId) {
          body.conversation_id = difyConversationId;
        }

        console.log(`Calling Dify ${apiUrl} (conversation_id=${difyConversationId || 'none'})`);
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          body: JSON.stringify(body)
        });

        console.log(`Dify response status ${response.status} ${response.statusText} for ${apiUrl}`);
        if (response.ok) break;

        // try next endpoint on 404
        if (response.status === 404) {
          console.log(`Endpoint ${apiUrl} returned 404, trying next endpoint...`);
          continue;
        }

        // For other non-ok, log response body and continue
        const text = await response.text();
        console.warn(`Non-ok response from ${apiUrl}: ${text}`);
      } catch (err) {
        console.error(`Error calling Dify at ${apiUrl}:`, err.message);
        continue;
      }
    }

    if (!response) {
      console.error('No response from Dify endpoints');
      ws.send(JSON.stringify({ type: 'error', message: 'No response from Dify' }));
      return;
    }

    if (!response.ok) {
      const bodyText = await response.text();
      console.error('Dify final error:', bodyText);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Dify API call failed',
        details: bodyText
      }));
      return;
    }

    // 4) Handle streaming body (SSE/chunked)
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSent = '';
    let firstMessageSent = false;

    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;

          const payloadStr = line.startsWith('data: ') ? line.slice(6) : line;
          try {
            const data = JSON.parse(payloadStr);

            // If Dify reports a conversation_id, persist it (map local conversation -> dify id)
            if (data.conversation_id && data.conversation_id !== difyConversationId) {
              difyConversationId = data.conversation_id;
              console.log('Received dify conversation id from Dify:', difyConversationId);
              // persist to DB
              try {
                if (databaseAvailable && pool && conversationId) {
                  await pool.query(
                    'UPDATE conversations SET dify_conversation_id = ? WHERE id = ?',
                    [difyConversationId, conversationId]
                  );
                  console.log('Persisted dify_conversation_id for local conversation:', conversationId);
                }
              } catch (err) {
                console.warn('Failed to persist dify_conversation_id:', err.message);
              }
            }

            // accumulate answer fragments from common fields (avoid duplicates)
            let newContent = '';
            if (data.answer) {
              newContent = data.answer;
            } else if (data.text) {
              newContent = data.text;
            } else if (data.data && data.data.outputs) {
              const outputs = data.data.outputs;
              if (outputs.answer) newContent = outputs.answer;
              else if (outputs.sys && outputs.sys.answer) newContent = outputs.sys.answer;
            }

            // Simple and effective deduplication
            if (newContent && newContent.trim()) {
              const trimmedNew = newContent.trim();
              
              // Skip if already have this exact content
              if (fullResponse.trim() === trimmedNew) {
                continue;
              }
              
              // Skip if new content is already contained in fullResponse
              if (fullResponse.includes(trimmedNew)) {
                continue;
              }
              
              // If fullResponse is contained in newContent, add only the new part
              if (trimmedNew.includes(fullResponse.trim())) {
                const extra = trimmedNew.slice(fullResponse.trim().length).trim();
                if (extra) {
                  fullResponse += (fullResponse ? ' ' : '') + extra;
                }
                continue;
              }
              
              // No overlap, append normally
              fullResponse += (fullResponse ? ' ' : '') + trimmedNew;
            }

            // Only send to client when the text changed
            if (fullResponse !== lastSent) {
              const processed = processAIResponse(fullResponse);
              ws.send(JSON.stringify({
                type: 'streaming_message',
                id: assistantMessageId,
                conversationId: conversationId,
                role: 'assistant',
                content: processed.mainContent,
                thinks: processed.thinks,
                isStreaming: true,
                createdAt: new Date().toISOString()
              }));
              lastSent = fullResponse;
              firstMessageSent = true;
            }
          } catch (err) {
            console.error('Failed to parse SSE line:', err, payloadStr);
          }
        }
      }

      // end of stream: send final message only if we actually sent content
      if (fullResponse && firstMessageSent) {
        const processed = processAIResponse(fullResponse);
        ws.send(JSON.stringify({
          type: 'streaming_message',
          id: assistantMessageId,
          conversationId: conversationId,
          role: 'assistant',
          content: processed.mainContent,
          thinks: processed.thinks,
          isStreaming: false,
          createdAt: new Date().toISOString()
        }));

        // Save full answer into DB (update messages record)
        if (databaseAvailable && pool) {
          try {
            await pool.query(
              'UPDATE messages SET answer = ?, think = ?, ai_update_at = NOW() WHERE id = ?',
              [processed.mainContent, JSON.stringify(processed.thinks), userMessageId]
            );
          } catch (err) {
            console.warn('Failed to update messages table with AI response:', err.message);
          }
        }
      } else {
        // fallback to mock if nothing
        await mockAIResponse(ws, conversationId, message, helper);
      }
    } catch (err) {
      console.error('Error reading Dify stream:', err);
      await mockAIResponse(ws, conversationId, message, helper);
    }
  } catch (err) {
    console.error('callDifyAPI top-level error:', err);
    await mockAIResponse(ws, conversationId, message, helper);
  }
}

// Handle new message from client
async function handleNewMessage(ws, data) {
  let { conversationId, message, userId } = data;

  // Generate a valid userId if none provided or if it's too long (more than 36 characters for UUID)
  userId = (userId && userId.length === 36) ? userId : uuidv4();

  // Create user if not exists
  let user = await createUserIfNotExists(userId);

  // Create conversation if not exists
  let conversation = await createConversationIfNotExists(conversationId, user.id);

  // Save user message to database
  const userMessageId = uuidv4();
  if (databaseAvailable && pool) {
    try {
      await pool.query(
        'INSERT INTO messages (id, user, conversation_id, query, answer, helper) VALUES (?, ?, ?, ?, ?, ?)',
        [userMessageId, user.id, conversation.id, message, '', data.helper || 'cisco']
      );
    } catch (err) {
      console.error('Failed to insert user message into DB:', err.message);
    }
  } else {
    // fallback to in-memory
    inMemoryMessages.set(userMessageId, {
      id: userMessageId,
      user: user.id,
      conversation_id: conversation.id,
      query: message,
      answer: '',
      helper: data.helper || 'cisco',
      created_at: new Date()
    });
  }

  // Send user message back to client
  ws.send(JSON.stringify({
    type: 'message',
    id: userMessageId,
    conversationId: conversation.id,
    role: 'user',
    content: message,
    helper: data.helper || 'cisco',
    createdAt: new Date().toISOString()
  }));

  // Call Dify API for AI response
  await callDifyAPI(ws, conversation.id, message, userMessageId, data.helper);

  // If conversation was just created (i.e., if original conversationId was empty), send conversation_id to client
  if (!data.conversationId || data.conversationId === '') {
    ws.send(JSON.stringify({
      type: 'conversation_created',
      conversationId: conversation.id
    }));
  }
}

// Handle getting conversations
async function handleGetConversations(ws, data) {
  let { userId } = data;

  // Generate a valid userId if none provided
  userId = userId || uuidv4();

  // Create user if not exists
  let user = await createUserIfNotExists(userId);

  if (databaseAvailable && pool) {
    try {
      const [conversations] = await pool.query(
        'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
        [user.id]
      );

      ws.send(JSON.stringify({
        type: 'conversations',
        conversations: conversations
      }));
    } catch (err) {
      console.error('Failed to query conversations:', err);
      ws.send(JSON.stringify({ type: 'conversations', conversations: [] }));
    }
  } else {
    // in-memory fallback
    const list = Array.from(inMemoryConversations.values()).filter(c => c.user_id === user.id);
    ws.send(JSON.stringify({ type: 'conversations', conversations: list }));
  }
}

// Handle getting messages for a conversation
async function handleGetMessages(ws, data) {
  const { conversationId } = data;

  if (databaseAvailable && pool) {
    try {
      const [messages] = await pool.query(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
        [conversationId]
      );

      // Convert database messages to frontend expected format
      const formattedMessages = [];

      messages.forEach(dbMsg => {
        // Add user message if query exists
        if (dbMsg.query) {
          formattedMessages.push({
            id: dbMsg.id,
            conversationId: dbMsg.conversation_id,
            role: 'user',
            content: dbMsg.query,
            helper: dbMsg.helper,
            thinks: [],
            isStreaming: false,
            createdAt: new Date(dbMsg.created_at).toISOString(),
            showThinks: false
          });
        }

        // Add assistant message if answer exists
        if (dbMsg.answer) {
          let thinks = [];
          if (dbMsg.think) {
            try {
              thinks = JSON.parse(dbMsg.think);
              if (!Array.isArray(thinks)) thinks = [thinks];
            } catch (e) {
              thinks = [];
            }
          }

          formattedMessages.push({
            id: dbMsg.id + '_assistant',
            conversationId: dbMsg.conversation_id,
            role: 'assistant',
            content: dbMsg.answer,
            helper: dbMsg.helper,
            thinks: thinks,
            isStreaming: false,
            createdAt: new Date(dbMsg.ai_update_at || dbMsg.created_at).toISOString(),
            showThinks: false
          });
        }
      });

      ws.send(JSON.stringify({
        type: 'messages',
        conversationId: conversationId,
        messages: formattedMessages
      }));
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      ws.send(JSON.stringify({ type: 'messages', conversationId, messages: [] }));
    }
  } else {
    // in-memory fallback: try to build messages array
    const formatted = [];
    for (const [, m] of inMemoryMessages) {
      if (m.conversation_id === conversationId) {
        // user entry
        if (m.query) {
          formatted.push({
            id: m.id,
            conversationId: m.conversation_id,
            role: 'user',
            content: m.query,
            helper: m.helper,
            thinks: [],
            isStreaming: false,
            createdAt: new Date(m.created_at).toISOString(),
            showThinks: false
          });
        }
        // assistant entry if answer exists
        if (m.answer) {
          formatted.push({
            id: m.id + '_assistant',
            conversationId: m.conversation_id,
            role: 'assistant',
            content: m.answer,
            helper: m.helper,
            thinks: [],
            isStreaming: false,
            createdAt: new Date(m.created_at).toISOString(),
            showThinks: false
          });
        }
      }
    }
    ws.send(JSON.stringify({ type: 'messages', conversationId, messages: formatted }));
  }
}

// Handle creating a new conversation
async function handleCreateConversation(ws, data) {
  let { userId, title } = data;

  userId = userId || uuidv4();
  let user = await createUserIfNotExists(userId);

  const conversationId = uuidv4();
  if (databaseAvailable && pool) {
    try {
      await pool.query(
        'INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)',
        [conversationId, user.id, title || 'New Conversation']
      );

      const [conversations] = await pool.query(
        'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
        [user.id]
      );

      ws.send(JSON.stringify({
        type: 'conversations',
        conversations: conversations
      }));

      // Send conversation_created to client
      ws.send(JSON.stringify({
        type: 'conversation_created',
        conversationId: conversationId
      }));
    } catch (err) {
      console.error('Failed to create conversation:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to create conversation' }));
    }
  } else {
    // in-memory fallback
    const conversation = {
      id: conversationId,
      user_id: user.id,
      title: title || 'New Conversation',
      created_at: new Date(),
      updated_at: new Date()
    };
    inMemoryConversations.set(conversationId, conversation);

    const list = Array.from(inMemoryConversations.values()).filter(c => c.user_id === user.id);
    ws.send(JSON.stringify({ type: 'conversations', conversations: list }));
    ws.send(JSON.stringify({ type: 'conversation_created', conversationId }));
  }
}

async function handleDeleteConversation(ws, data) {
  let { conversationId, userId } = data;

  console.log('DEBUG: handleDeleteConversation called with:', {
    conversationId,
    userId,
    databaseAvailable,
    hasPool: !!pool
  });

  userId = userId || uuidv4();
  let user = await createUserIfNotExists(userId);

  if (databaseAvailable && pool) {
    try {
      console.log('DEBUG: Deleting messages for conversation:', conversationId);
      const [deleteMessagesResult] = await pool.query(
        'DELETE FROM messages WHERE conversation_id = ?',
        [conversationId]
      );
      console.log('DEBUG: Messages deleted result:', deleteMessagesResult);

      console.log('DEBUG: Deleting conversation:', conversationId, 'for user:', user.id);
      const [deleteConversationResult] = await pool.query(
        'DELETE FROM conversations WHERE id = ? AND user_id = ?',
        [conversationId, user.id]
      );
      console.log('DEBUG: Conversation deleted result:', deleteConversationResult);

      if (deleteConversationResult.affectedRows === 0) {
        console.log('DEBUG: No conversation found with id:', conversationId, 'for user:', user.id);
      }

      const [conversations] = await pool.query(
        'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
        [user.id]
      );
      ws.send(JSON.stringify({
        type: 'conversations',
        conversations: conversations
      }));
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to delete conversation' }));
    }
  } else {
    // in-memory fallback
    inMemoryMessages.forEach((m, key) => {
      if (m.conversation_id === conversationId) inMemoryMessages.delete(key);
    });
    inMemoryConversations.delete(conversationId);
    ws.send(JSON.stringify({ type: 'conversations', conversations: Array.from(inMemoryConversations.values()) }));
  }
}

// Create user if not exists
async function createUserIfNotExists(userId) {
  let user;
  if (databaseAvailable && pool) {
    try {
      const [existingUsers] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);

      if (existingUsers.length === 0) {
        await pool.query(
          'INSERT INTO users (id, username) VALUES (?, ?)',
          [userId, `user_${Date.now()}`]
        );
        const [newUsers] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
        user = newUsers[0];
      } else {
        user = existingUsers[0];
      }
    } catch (err) {
      console.error('Error in createUserIfNotExists DB flow:', err);
      // fallback to in-memory
      if (!inMemoryUsers.has(userId)) {
        inMemoryUsers.set(userId, {
          id: userId,
          username: `user_${Date.now()}`,
          createdAt: new Date()
        });
      }
      user = inMemoryUsers.get(userId);
    }
  } else {
    if (!inMemoryUsers.has(userId)) {
      inMemoryUsers.set(userId, {
        id: userId,
        username: `user_${Date.now()}`,
        createdAt: new Date()
      });
    }
    user = inMemoryUsers.get(userId);
  }
  return user;
}

// Create conversation if not exists
async function createConversationIfNotExists(conversationId, userId) {
  let conversation;
  if (databaseAvailable && pool) {
    try {
      if (conversationId) {
        const [existingConversations] = await pool.query(
          'SELECT * FROM conversations WHERE id = ?',
          [conversationId]
        );

        if (existingConversations.length > 0) {
          conversation = existingConversations[0];
        }
      }

      if (!conversation) {
        const newConversationId = conversationId || uuidv4();
        await pool.query(
          'INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)',
          [newConversationId, userId, 'New Conversation']
        );
        const [newConversations] = await pool.query(
          'SELECT * FROM conversations WHERE id = ?',
          [newConversationId]
        );
        conversation = newConversations[0];
      }
    } catch (err) {
      console.error('Error in createConversationIfNotExists DB flow:', err);
      // fallback to in-memory
      if (conversationId && inMemoryConversations.has(conversationId)) {
        conversation = inMemoryConversations.get(conversationId);
      } else {
        const newConversationId = conversationId || uuidv4();
        conversation = {
          id: newConversationId,
          user_id: userId,
          title: 'New Conversation',
          created_at: new Date(),
          updated_at: new Date()
        };
        inMemoryConversations.set(newConversationId, conversation);
      }
    }
  } else {
    if (conversationId && inMemoryConversations.has(conversationId)) {
      conversation = inMemoryConversations.get(conversationId);
    } else {
      const newConversationId = conversationId || uuidv4();
      conversation = {
        id: newConversationId,
        user_id: userId,
        title: 'New Conversation',
        created_at: new Date(),
        updated_at: new Date()
      };
      inMemoryConversations.set(newConversationId, conversation);
    }
  }
  return conversation;
}

// Initialize WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server });

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('Client connected to WebSocket server from IP:', req.socket.remoteAddress);
  console.log('Request headers:', req.headers);

  // Send welcome message
  ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to WebSocket server' }));

  ws.on('message', async (message) => {
    try {
      console.log('Received message from client:', message.toString());
      const data = JSON.parse(message);

      switch (data.type) {
        case 'new_message':
          console.log('Handling new_message:', data);
          await handleNewMessage(ws, data);
          break;
        case 'get_conversations':
          console.log('Handling get_conversations:', data);
          await handleGetConversations(ws, data);
          break;
        case 'get_messages':
          console.log('Handling get_messages:', data);
          await handleGetMessages(ws, data);
          break;
        case 'create_conversation':
          console.log('Handling create_conversation:', data);
          await handleCreateConversation(ws, data);
          break;
        case 'delete_conversation':
          console.log('Handling delete_conversation:', data);
          await handleDeleteConversation(ws, data);
          break;
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      console.error('Error stack:', error.stack);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`Client disconnected from WebSocket server: code=${code}, reason=${reason}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    console.error('Error stack:', error.stack);
  });
});

// Initialize database
initializeDatabase();

// Start combined HTTP and WebSocket server
server.listen(httpPort, () => {
  console.log(`Server running on port ${httpPort}`);
  console.log(`Static files served from ${path.join(__dirname, 'dist')}`);
  console.log(`WebSocket server running on the same port ${httpPort}`);
});
