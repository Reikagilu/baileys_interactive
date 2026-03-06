/**
 * Tipos para o socket InfiniteAPI/Baileys.
 * O socket expõe sendMessage com nativeButtons, nativeList, nativeCarousel, etc.
 */
export interface InstanceContext {
  name: string;
  sock: WASocketLike;
  status: 'connecting' | 'connected' | 'disconnected' | 'qr';
  qr: string | null;
  createdAt: Date;
  authFolder: string;
  linkedNumber?: string | null;
  profilePictureUrl?: string | null;
  profileName?: string | null;
}

export interface WASocketLike {
  sendMessage: (jid: string, content: MessageContent) => Promise<{ key?: { id?: string }; messageTimestamp?: number }>;
  relayMessage?: (jid: string, content: unknown, opts?: unknown) => Promise<unknown>;
  requestPairingCode?: (phoneNumber: string) => Promise<string>;
  readMessages?: (keys: Array<{ remoteJid: string; id: string; participant?: string; fromMe?: boolean }>) => Promise<void>;
  chatModify?: (modification: unknown, jid: string, participants?: unknown[]) => Promise<unknown>;
  sendPresenceUpdate?: (presence: string, toJid?: string) => Promise<unknown>;
  profilePictureUrl?: (jid: string, type?: string) => Promise<string>;
  rejectCall?: (callId: string, callFrom: string) => Promise<unknown>;
  user?: { id?: string; name?: string };
  ev: { on: (event: string, handler: (...args: unknown[]) => void) => void };
  logout?: () => Promise<void>;
  ws?: { close: () => void };
}

export interface NativeButtonReply {
  type: 'reply';
  id: string;
  text: string;
}

export interface NativeButtonUrl {
  type: 'url';
  text: string;
  url: string;
}

export interface NativeButtonCopy {
  type: 'copy';
  text: string;
  copyText: string;
}

export interface NativeButtonCall {
  type: 'call';
  text: string;
  phoneNumber: string;
}

export type NativeButton = NativeButtonReply | NativeButtonUrl | NativeButtonCopy | NativeButtonCall;

export interface NativeListRow {
  id: string;
  title: string;
  description?: string;
}

export interface NativeListSection {
  title: string;
  rows: NativeListRow[];
}

export interface NativeCarouselCard {
  title?: string;
  body?: string;
  footer?: string;
  image?: { url: string };
  imageUrl?: string;
  buttons?: Array<{ type?: string; id: string; text: string }>;
}

export interface MessageContent {
  text?: string;
  footer?: string;
  nativeButtons?: NativeButton[];
  nativeList?: {
    buttonText: string;
    sections: NativeListSection[];
  };
  nativeCarousel?: {
    cards: NativeCarouselCard[];
  };
  poll?: {
    name: string;
    values: string[];
    selectableCount?: number;
  };
  pollCreationMessage?: {
    name: string;
    options: Array<{ optionName: string }>;
    selectableOptionsCount?: number;
  };
  [key: string]: unknown;
}
