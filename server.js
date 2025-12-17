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

const httpPort = 80;

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
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    
    // Create messages table if not exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(36) NOT NULL,
        role ENUM('user', 'assistant') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);
    
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
async function mockAIResponse(ws, conversationId, message) {
  const assistantMessageId = uuidv4();
  const mockResponses = {
    '你好': '你好！我是一个AI助手，很高兴为您服务。',
    '今天天气怎么样': '抱歉，我无法获取实时天气信息，但您可以尝试使用天气应用或网站查询。',
    '你能做什么': '我可以帮助您回答问题、提供信息、进行对话等。',
    '谢谢': '不客气！如果您有任何其他问题，随时可以问我。'
  };
  
  // Get a mock response or use a default
  const responseText = mockResponses[message] || `我收到了您的消息："${message}"。这是一个模拟的AI响应，因为Dify API调用失败了。`;
  
  // Simulate streaming response
  let currentText = '';
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
    // Simulate typing delay
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  
  // End of streaming
  ws.send(JSON.stringify({
    type: 'streaming_message',
    id: assistantMessageId,
    conversationId: conversationId,
    role: 'assistant',
    content: responseText,
    isStreaming: false,
    createdAt: new Date().toISOString()
  }));
  
  // Save full response to database
  if (databaseAvailable && pool) {
    await pool.query(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
      [assistantMessageId, conversationId, 'assistant', responseText]
    );
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
    await pool.query(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
      [userMessageId, conversation.id, 'user', message]
    );
  }
  
  // Send user message back to client
  ws.send(JSON.stringify({
    type: 'message',
    id: userMessageId,
    conversationId: conversation.id,
    role: 'user',
    content: message,
    createdAt: new Date().toISOString()
  }));
  
  // Call Dify API for AI response
  await callDifyAPI(ws, conversation.id, message);
  
  // If conversation was just created (i.e., if original conversationId was empty), send conversation_id to client
  if (!data.conversationId || data.conversationId === '') {
    ws.send(JSON.stringify({
      type: 'conversation_created',
      conversationId: conversation.id
    }));
  }
}

// Function to process AI response, remove duplicates and extract think sections
function processAIResponse(response) {
  // Initialize variables
  const thinks = [];
  let mainContent = response;
  const uniqueThinks = new Set();
  
  // First handle complete <think> tags with proper closing
  const completeThinkPattern = /<think>([\s\S]*?)<\/think>/g;
  let match;
  
  while ((match = completeThinkPattern.exec(response)) !== null) {
    const thinkContent = match[1].trim();
    if (thinkContent && !uniqueThinks.has(thinkContent)) {
      uniqueThinks.add(thinkContent);
      thinks.push(thinkContent);
    }
  }
  
  // Remove all complete think tags from main content
  mainContent = mainContent.replace(completeThinkPattern, '').trim();
  
  // Now handle incomplete think tags (missing closing tag)
  const incompleteThinkPattern = /<think>([\s\S]*)$/;
  const incompleteMatch = mainContent.match(incompleteThinkPattern);
  
  if (incompleteMatch) {
    const thinkContent = incompleteMatch[1].trim();
    if (thinkContent && !uniqueThinks.has(thinkContent)) {
      uniqueThinks.add(thinkContent);
      thinks.push(thinkContent);
    }
    // Remove incomplete think tag from main content
    mainContent = mainContent.replace(incompleteThinkPattern, '').trim();
  }
  
  // Handle any remaining partial think tags
  mainContent = mainContent.replace(/<think>/g, '').trim();
  mainContent = mainContent.replace(/<\/think>/g, '').trim();
  
  // Handle think content that might be in the middle of text
  const midTextThinkPattern = /<think>([^<]*)/g;
  while ((match = midTextThinkPattern.exec(mainContent)) !== null) {
    const thinkContent = match[1].trim();
    if (thinkContent && !uniqueThinks.has(thinkContent)) {
      uniqueThinks.add(thinkContent);
      thinks.push(thinkContent);
    }
    mainContent = mainContent.replace(midTextThinkPattern, '').trim();
  }
  
  // Remove duplicate content from the main message
  const finalContent = removeDuplicates(mainContent);
  
  return {
    thinks,
    mainContent: finalContent
  };
}

// Function to remove duplicate content from AI response
function removeDuplicates(response) {
  // Remove duplicate think sections first
  const thinkPattern = /(<think>([\s\S]*?)<\/think>)/g;
  const thinkMatches = [];
  let thinkMatch;
  
  // Extract all think sections
  while ((thinkMatch = thinkPattern.exec(response)) !== null) {
    thinkMatches.push(thinkMatch[1]);
  }
  
  // Remove duplicate think sections
  let cleanResponse = response;
  if (thinkMatches.length > 1) {
    // Keep only the first think section
    cleanResponse = cleanResponse.replace(thinkPattern, thinkMatches[0]);
  }
  
  // Find all occurrences of the main response pattern
  const mainPattern = /你好！我是网络工程师，很高兴能帮助你学习网络相关知识。([\s\S]*?)😊/g;
  const mainMatches = [];
  let mainMatch;
  
  while ((mainMatch = mainPattern.exec(cleanResponse)) !== null) {
    mainMatches.push(mainMatch[0]);
  }
  
  if (mainMatches.length > 0) {
    // Return only the first occurrence along with any preceding content
    const firstMatchIndex = cleanResponse.indexOf(mainMatches[0]);
    return cleanResponse.slice(0, firstMatchIndex + mainMatches[0].length);
  }
  
  // Fallback: remove any exact duplicate content using a more general approach
  const lines = cleanResponse.split('\n');
  const uniqueLines = [];
  const seen = new Set();
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine && !seen.has(trimmedLine)) {
      seen.add(trimmedLine);
      uniqueLines.push(line);
    }
  }
  
  return uniqueLines.join('\n');
}

// Call Dify API for streaming response
async function callDifyAPI(ws, conversationId, message) {
  try {
    const assistantMessageId = uuidv4();
    let fullResponse = '';
    
    // Try different Dify API endpoints
    const difyUrl = process.env.DIFY_API_URL;
    const apiKey = process.env.DIFY_API_KEY;
    
    // Ensure conversation_id is never null or undefined when calling Dify API
    // If conversationId is null/undefined, generate a new UUID
    const difyConversationId = conversationId || uuidv4();
    
    // Try multiple API endpoints in order until we find a working one
    const endpoints = [
      `${difyUrl}/v1/chat/completions`,  // Common Dify API endpoint
      `${difyUrl}/v1/chat-messages`,     // Original endpoint
      `${difyUrl}/api/chat-messages`     // API prefixed endpoint
    ];
    
    let response;
    let apiUrl;
    
    // Try each endpoint until we get a successful response
    for (const endpoint of endpoints) {
      try {
        apiUrl = endpoint;
        console.log(`Calling Dify API at: ${apiUrl}`);
        console.log(`API Key: ${apiKey}`);
        console.log(`Conversation ID: ${difyConversationId}`);
        
        // Only use Bearer token authentication (tested and working)
        const authHeaders = { 'Authorization': `Bearer ${apiKey}` };
        
        // Try calling API without conversation_id first (let Dify create a new one)
        try {
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders
            },
            body: JSON.stringify({
              inputs: {},
              query: message,
              response_mode: 'streaming',
              user: 'local-user'
            })
          });
          
          console.log(`Dify API response status without conversation_id: ${response.status} ${response.statusText}`);
          
          // If we get a successful response, break out of the loop
          if (response.ok) {
            break;
          }
          
          // If we get a 404 and have a valid conversation_id, try with conversation_id
          if (response.status === 404 && difyConversationId) {
            console.log(`Trying with conversation_id: ${difyConversationId}`);
            response = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders
              },
              body: JSON.stringify({
                inputs: {},
                query: message,
                response_mode: 'streaming',
                conversation_id: difyConversationId,
                user: 'local-user'
              })
            });
            
            console.log(`Dify API response status with conversation_id: ${response.status} ${response.statusText}`);
            
            // If we get a successful response, break out of the loop
            if (response.ok) {
              break;
            }
          }
        } catch (error) {
          console.error(`Error calling Dify API: ${error.message}`);
          // Try next endpoint
          continue;
        }
        
        // If we get a 404, try the next endpoint
        if (response && response.status === 404) {
          console.log(`Endpoint ${apiUrl} returned 404, trying next endpoint...`);
          continue;
        }
        
        // For other errors, break and handle
        break;
      } catch (error) {
        console.error(`Error calling Dify API at ${apiUrl}: ${error.message}`);
        // Try next endpoint
        continue;
      }
    }
    
    // Check if we got a response
    if (!response) {
      console.error('No response from Dify API after trying all endpoints');
      return;
    }
    
    if (!response.ok) {
      // Get detailed error information from response
      const errorBody = await response.text();
      console.error(`Dify API error details: ${errorBody}`);
      
      // Don't use mock AI response, just return error
      console.log('Dify API call failed, not using mock response');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Dify API call failed',
        details: errorBody
      }));
      return;
    }
    
    // Debug: Log response headers
    console.log('Dify API response headers:', JSON.stringify(response.headers.raw(), null, 2));
    
    // Handle streaming response in Node.js way
    const decoder = new TextDecoder();
    
    // Check if response is streaming
    const contentType = response.headers.get('content-type');
    console.log(`Dify API response Content-Type: ${contentType}`);
    
    // Process response as real SSE streaming
    console.log('Processing Dify API response as real SSE streaming');
    let buffer = '';
    let isStreaming = true;
    
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        console.log(`Received chunk, current buffer: ${buffer}`);
        
        // Process complete lines
        let newlineIndex;
        let lastResponseSent = '';
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              console.log(`Parsed SSE event: ${data.event}, data: ${JSON.stringify(data)}`);
              
              // Store previous response to check for changes
              const previousResponse = fullResponse;
              
              // Handle different event types
              switch (data.event) {
                case 'message':
                  // Standard message event with answer
                  if (data.answer) {
                    fullResponse += data.answer;
                    console.log(`Received answer chunk: ${data.answer}, current fullResponse: ${fullResponse}`);
                  }
                  break;
                  
                case 'node_finished':
                  // Check if this node contains answer in its outputs
                  if (data.data && data.data.outputs) {
                    console.log(`Node outputs: ${JSON.stringify(data.data.outputs)}`);
                    
                    // Check for answer in different output locations
                    let answerFound = false;
                    if (data.data.outputs.answer) {
                      fullResponse += data.data.outputs.answer;
                      answerFound = true;
                    } else if (data.data.outputs.sys && data.data.outputs.sys.answer) {
                      fullResponse += data.data.outputs.sys.answer;
                      answerFound = true;
                    } else if (data.data.outputs['sys.query'] && data.data.outputs['sys.query'] !== message) {
                      fullResponse += data.data.outputs['sys.query'];
                      answerFound = true;
                    } else {
                      // Try to find any text field that might contain the answer
                      for (const [key, value] of Object.entries(data.data.outputs)) {
                        if (typeof value === 'string' && value.length > 0) {
                          fullResponse += value;
                          answerFound = true;
                          break;
                        } else if (typeof value === 'object' && value !== null) {
                          for (const [subKey, subValue] of Object.entries(value)) {
                            if (typeof subValue === 'string' && subValue.length > 0) {
                              fullResponse += subValue;
                              answerFound = true;
                              break;
                            }
                          }
                        }
                        if (answerFound) break;
                      }
                    }
                  }
                  break;
                  
                case 'message_end':
                  // End of message event - just mark streaming as complete
                  isStreaming = false;
                  break;
                  
                case 'workflow_started':
                case 'node_started':
                  // These events don't contain answer, just log them
                  console.log(`Workflow event: ${data.event}, conversation_id: ${data.conversation_id}`);
                  break;
                  
                default:
                  console.log(`Unknown event type: ${data.event}`);
              }
              
              // Only send response if fullResponse has changed
              if (fullResponse !== previousResponse && fullResponse !== lastResponseSent) {
                // Process the response to remove duplicates and extract think sections
                const processed = processAIResponse(fullResponse);
                
                console.log(`Sending streaming response: ${processed.mainContent}`);
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
                lastResponseSent = fullResponse;
              }
            } catch (error) {
              console.error('Error parsing SSE data:', error);
              console.error('Error line:', line);
            }
          }
        }
      }
      
      // Send final response if streaming has ended
      if (!isStreaming && fullResponse) {
        console.log('Streaming ended, sending final message');
        
        // Process the final response to remove duplicates and extract think sections
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
        
        // Save processed main content to database
        if (databaseAvailable && pool) {
          await pool.query(
            'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
            [assistantMessageId, conversationId, 'assistant', processed.mainContent]
          );
          console.log('Saved full response to database');
        }
      } else if (isStreaming && fullResponse) {
        // If we're still streaming after reading all chunks, send final message
        console.log('Streaming ended without message_end event, sending final message');
        
        // Process the final response to remove duplicates and extract think sections
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
        
        // Save processed main content to database
        if (databaseAvailable && pool) {
          await pool.query(
            'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
            [assistantMessageId, conversationId, 'assistant', processed.mainContent]
          );
          console.log('Saved full response to database');
        }
      }
      
      // If no response received after all chunks, use mock
      if (!fullResponse) {
        console.log('No answer found in any SSE events, falling back to mock response');
        await mockAIResponse(ws, conversationId, message);
      }
    } catch (error) {
      console.error('Error processing SSE response:', error);
      await mockAIResponse(ws, conversationId, message);
    }
  } catch (error) {
    console.error('Error calling Dify API:', error);
    
    // Fallback to mock AI response if any error occurs
    console.log('Falling back to mock AI response due to error:', error.message);
    mockAIResponse(ws, conversationId, message);
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
    const [conversations] = await pool.query(
      'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
      [user.id]
    );
    
    ws.send(JSON.stringify({
      type: 'conversations',
      conversations: conversations
    }));
  }
}

// Handle getting messages for a conversation
async function handleGetMessages(ws, data) {
  const { conversationId } = data;
  
  if (databaseAvailable && pool) {
    const [messages] = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [conversationId]
    );
    
    ws.send(JSON.stringify({
      type: 'messages',
      conversationId: conversationId,
      messages: messages
    }));
  }
}

// Handle creating a new conversation
async function handleCreateConversation(ws, data) {
  let { userId, title } = data;
  
  // Generate a valid userId if none provided
  userId = userId || uuidv4();
  
  // Create user if not exists
  let user = await createUserIfNotExists(userId);
  
  const conversationId = uuidv4();
  if (databaseAvailable && pool) {
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
    
    ws.send(JSON.stringify({
      type: 'conversation_created',
      conversationId: conversationId
    }));
  }
}

// Create user if not exists
async function createUserIfNotExists(userId) {
  let user;
  if (databaseAvailable && pool) {
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
  } else {
    // Fallback to in-memory storage
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
  } else {
    // Fallback to in-memory storage
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
  
  // Log connection details
  console.log('WebSocket protocol:', req.headers['sec-websocket-protocol']);
  console.log('Origin:', req.headers.origin);
  
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
