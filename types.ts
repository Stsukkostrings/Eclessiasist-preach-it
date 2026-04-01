
export interface BibleVerse {
  reference: string;
  text: string;
  version: string;
}

export interface SermonNote {
  id: string;
  keyword: string;
  title: string;
  content: string;
}

export interface OverlayState {
  type: 'scripture' | 'note' | 'none';
  data: BibleVerse | SermonNote | null;
  visible: boolean;
}

export interface TranscriptionLog {
  timestamp: Date;
  text: string;
  detectedRef?: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
