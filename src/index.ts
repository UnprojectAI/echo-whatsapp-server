import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import express, { Request, Response, Application } from 'express';
import cors from 'cors';
import http from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';

const app: Application = express();
const server = http.createServer(app);

// Configure CORS
app.use(cors({
  origin: '*',
  methods: ["GET", "POST", "DELETE"],
  credentials: true
}));

// Configure Socket.IO with more detailed options
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 120000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  connectTimeout: 45000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e8,
  path: '/socket.io/',
  serveClient: false,
  cookie: false
});

app.use(express.json());

// Add basic health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Store multiple WhatsApp clients
const clients = new Map<string, Client>();

// Function to create a new WhatsApp client
const createWhatsAppClient = (clientId: string) => {
  const authPath = path.join(__dirname, '.wwebjs_auth', clientId);
  
  // Create auth directory if it doesn't exist
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: clientId,
      dataPath: authPath
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-translate',
        '--disable-sync',
        '--disable-background-networking',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        '--js-flags=--max-old-space-size=512'
      ],
      executablePath: process.platform === 'darwin' 
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined
    },
    qrMaxRetries: 5,
    authTimeoutMs: 60000,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0
  });

  // WhatsApp event handlers
  client.on('loading_screen', (percent: number, message: string) => {
    console.log(`[${clientId}] Loading:`, percent, '%', message);
  });

  client.on('qr', (qr: string) => {
    console.log(`[${clientId}] QR Code received`);
    // Emit to all connected clients
    io.emit(`qr_${clientId}`, qr);
  });

  client.on('qr_max_retries', () => {
    console.log(`[${clientId}] Maximum QR code retries reached`);
    try {
      // Remove client from the Map
      clients.delete(clientId);
      // Notify connected clients
      io.emit(`error_${clientId}`, 'Maximum QR code retries reached. Session removed.');
      // Attempt to destroy the client
      client.destroy().catch(err => {
        console.error(`[${clientId}] Error destroying client:`, err);
      });
    } catch (error) {
      console.error(`[${clientId}] Error handling qr_max_retries:`, error);
    }
  });

  client.on('ready', () => {
    console.log(`[${clientId}] Client is ready!`);
    io.emit(`ready_${clientId}`, client.info?.wid?.user);
  });

  client.on('authenticated', () => {
    console.log(`[${clientId}] Client is authenticated!`);
  });

  client.on('auth_failure', (msg: string) => {
    console.error(`[${clientId}] Authentication failure:`, msg);
    try {
      io.emit(`error_${clientId}`, 'Authentication failed. Please try again.');
      // Remove client from the Map
      clients.delete(clientId);
      // Attempt to destroy the client
      client.destroy().catch(err => {
        console.error(`[${clientId}] Error destroying client:`, err);
      });
    } catch (error) {
      console.error(`[${clientId}] Error handling auth_failure:`, error);
    }
  });

  client.on('disconnected', (reason: string) => {
    console.log(`[${clientId}] Client was disconnected:`, reason);
    try {
      // Only delete client if the reason indicates actual unlinking
      if (reason === 'LOGOUT' || reason === 'UNPAIRED') {
        clients.delete(clientId);
        console.log(`[${clientId}] Session removed due to unlinking`);
      }
      io.emit(`disconnected_${clientId}`, reason);
    } catch (error) {
      console.error(`[${clientId}] Error handling disconnected:`, error);
    }
  });

  client.on('message', async (message: Message) => {
    try {
      console.log(`[${clientId}] Message received:`, message.body);
      io.emit(`message_${clientId}`, {
        from: message.from,
        body: message.body,
        timestamp: message.timestamp,
        phoneNumber: message.from.includes('@c.us') ? message.from : `${message.from}@c.us`,
        myNumber: client.info?.wid?.user
      });
    } catch (error) {
      console.error(`[${clientId}] Error handling message:`, error);
    }
  });

  return client;
};

// Socket.io connection handling
io.on('connection', (socket: Socket) => {
  console.log('Client connected with ID:', socket.id);

  // Send immediate connection confirmation
  socket.emit('connect_confirmation', { status: 'connected', socketId: socket.id });

  // Handle ping timeout
  socket.on('ping_timeout', () => {
    console.log(`Ping timeout for socket: ${socket.id}`);
    socket.emit('error', 'Connection timeout. Please reconnect.');
  });

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error(`Connection error for socket ${socket.id}:`, error);
    socket.emit('error', 'Connection error occurred. Please try reconnecting.');
  });

  socket.on('create_session', (clientId: string) => {
    console.log(`Creating new session for client: ${clientId}`);
    try {
      if (!clients.has(clientId)) {
        const client = createWhatsAppClient(clientId);
        clients.set(clientId, client);
        client.initialize().catch((err: Error) => {
          console.error(`[${clientId}] Error during initialization:`, err);
          socket.emit(`error_${clientId}`, 'Failed to initialize WhatsApp client');
          // Clean up on initialization failure
          clients.delete(clientId);
          client.destroy().catch(destroyErr => {
            console.error(`[${clientId}] Error destroying client after init failure:`, destroyErr);
          });
        });
      } else {
        console.log(`Session ${clientId} already exists`);
        socket.emit(`error_${clientId}_Session already exists`);
        const existingClient = clients.get(clientId);
        if (existingClient?.info) {
          socket.emit(`ready_${clientId}`);
        }
      }
    } catch (error) {
      console.error(`Error creating session for ${clientId}:`, error);
      socket.emit(`error_${clientId}`, 'Failed to create WhatsApp session');
    }
  });

  socket.on('disconnect', (reason: string) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
  });

  socket.on('error', (error: Error) => {
    console.error('Socket error:', error);
  });
});

// API endpoints
app.post('/api/send-message', async (req: Request, res: Response): Promise<void> => {
  try {
    const { clientId, to, message } = req.body;
    
    if (!clientId || !to || !message) {
      res.status(400).json({ 
        success: false, 
        error: 'Client ID, recipient number, and message are required' 
      });
      return;
    }

    const client = clients.get(clientId);
    if (!client) {
      res.status(404).json({ 
        success: false, 
        error: 'WhatsApp client not found' 
      });
      return;
    }

    if (!client.info) {
      res.status(400).json({ 
        success: false, 
        error: 'WhatsApp client is not initialized yet' 
      });
      return;
    }

    // Format the number to include @c.us suffix
    const formattedNumber = to.includes('@c.us') ? to : `${to}@c.us`;
    
    const response = await client.sendMessage(formattedNumber, message);
    res.json({ success: true, messageId: response.id });
  } catch (error: unknown) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send message' 
    });
  }
});

app.get('/api/sessions', (_req: Request, res: Response) => {
  const sessions = Array.from(clients.entries()).map(([clientId, client]) => ({
    clientId,
    status: client.info ? 'connected' : 'disconnected'
  }));
  res.json({ sessions });
});

app.delete('/api/session/:clientId', (req: Request, res: Response) => {
  const { clientId } = req.params;
  const client = clients.get(clientId);
  
  if (client) {
    client.destroy();
    clients.delete(clientId);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});

// New endpoint to fetch chat history
app.post('/api/chat-history', async (req: Request, res: Response): Promise<void> => {
  try {
    const { clientId, phoneNumber } = req.body;
    
    if (!clientId || !phoneNumber) {
      res.status(400).json({ 
        success: false, 
        error: 'Client ID and phone number are required' 
      });
      return;
    }

    const client = clients.get(clientId);
    if (!client) {
      res.status(404).json({ 
        success: false, 
        error: 'WhatsApp client not found' 
      });
      return;
    }

    if (!client.info) {
      res.status(400).json({ 
        success: false, 
        error: 'WhatsApp client is not initialized yet' 
      });
      return;
    }

    // Format the number to include @c.us suffix
    const formattedNumber = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
    
    // Fetch chat history using type assertion
    const chat = await (client as any).getChatById(formattedNumber);
    const messages = await chat.fetchMessages({ limit: 100 }); // Fetch last 100 messages

    // Format messages for response
    const formattedMessages = messages.map((msg: Message) => ({
      id: msg.id,
      from: msg.from,
      body: msg.body,
      timestamp: msg.timestamp
    }));

    res.json({ 
      success: true, 
      messages: formattedMessages 
    });
  } catch (error: unknown) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch chat history' 
    });
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
}); 