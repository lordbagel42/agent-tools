export type SessionStatus = {
  state: "starting" | "pairing_required" | "qr_ready" | "paired" | "closed";
  transport: "browser" | "native";
  connected?: boolean;
};

export type Conversation = {
  id: string;
  name: string;
  snippet: string;
  timestamp: string | null;
  unread: boolean;
};

export type Message = {
  id: string | null;
  direction: "incoming" | "outgoing" | "unknown";
  text: string;
  timestamp: string | null;
};

export type ConversationList = {
  conversations: Conversation[];
  limited: boolean;
};

export type MessageList = {
  conversationId: string;
  messages: Message[];
  coverage: "visible" | "recent";
  order: "oldest-first";
};

export type SendRequest = { conversationId: string; text: string };

export type SendReceipt = {
  conversationId: string;
  status: "submitted";
  delivery: "unconfirmed";
  submittedAt: string;
};

export interface MessagesClient {
  status(): Promise<SessionStatus>;
  pairingQr(): Promise<Buffer | null>;
  listConversations(limit: number): Promise<ConversationList>;
  readMessages(conversationId: string, limit: number): Promise<MessageList>;
  sendText(request: SendRequest): Promise<SendReceipt>;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
