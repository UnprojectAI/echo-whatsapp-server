declare module 'whatsapp-web.js' {
  export class Client {
    constructor(options: any);
    initialize(): Promise<void>;
    destroy(): Promise<void>;
    sendMessage(to: string, message: string): Promise<Message>;
    on(event: string, callback: (...args: any[]) => void): void;
    info?: any;
  }

  export class LocalAuth {
    constructor(options: { clientId: string; dataPath: string });
  }

  export interface Message {
    id: string;
    body: string;
    from: string;
    timestamp: number;
  }
} 