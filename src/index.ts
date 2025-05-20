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
  origin: ["http://localhost:3000", "http://hire.localhost:3001","http://hire.localhost:3000","http://localhost:3001","http://localhost:3002","http://hire.localhost:3002"],
  methods: ["GET", "POST", "DELETE"],
  credentials: true
}));

// Configure Socket.IO with more detailed options
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://hire.localhost:3001","http://hire.localhost:3000","http://localhost:3001","http://localhost:3002","http://hire.localhost:3002"],
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
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

  client.on('ready', () => {
    console.log(`[${clientId}] Client is ready!`);
    io.emit(`ready_${clientId}`, client.info?.wid?.user);
  });

  client.on('authenticated', () => {
    console.log(`[${clientId}] Client is authenticated!`);
  });

  client.on('auth_failure', (msg: string) => {
    console.error(`[${clientId}] Authentication failure:`, msg);
    io.emit(`error_${clientId}`, 'Authentication failed. Please try again.');
  });

  client.on('disconnected', (reason: string) => {
    console.log(`[${clientId}] Client was disconnected:`, reason);
    // Remove client from the Map
    clients.delete(clientId);
    console.log(clients)
    io.emit(`disconnected_${clientId}`, reason);
  });

  client.on('message', async (message: Message) => {
    console.log(`[${clientId}] Message received:`, message.body);
    io.emit(`message_${clientId}`, {
      from: message.from,
      body: message.body,
      timestamp: message.timestamp,
      phoneNumber: message.from.includes('@c.us') ? message.from : `${message.from}@c.us`,
      myNumber: client.info?.wid?.user
    });
  });

  return client;
};

// Socket.io connection handling
io.on('connection', (socket: Socket) => {
  console.log('Client connected with ID:', socket.id);

  // Send immediate connection confirmation
  socket.emit('connect_confirmation', { status: 'connected', socketId: socket.id });

  socket.on('create_session', (clientId: string) => {
    console.log(`Creating new session for client: ${clientId}`);
    if (!clients.has(clientId)) {
      const client = createWhatsAppClient(clientId);
      clients.set(clientId, client);
      client.initialize().catch((err: Error) => {
        console.error(`[${clientId}] Error during initialization:`, err);
        socket.emit(`error_${clientId}`, 'Failed to initialize WhatsApp client');
      });
    } else if (clients.has(clientId)) {
      console.log(`Session ${clientId} already exists`);
      const existingClient = clients.get(clientId);
      console.log(existingClient?.info?.status);
    }
    else {
      console.log(`Session ${clientId} already exists`);
      const existingClient = clients.get(clientId);
      if (existingClient?.info) {
        socket.emit(`ready_${clientId}`);
      }
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
}); 