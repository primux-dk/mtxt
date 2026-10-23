// The snapshot Rust sends (`app.rs`, `Snapshot`).

export type Permission = 'granted' | 'denied' | 'not_determined' | 'unsupported';
export type Status =
  | 'failed_local'
  | 'unreadable'
  | 'recording'
  | 'uploading'
  | 'pending'
  | 'warn'
  | 'ask_user'
  | 'confirmed'
  | 'deleted'
  | 'saved_elsewhere';
export type Reason =
  | { kind: 'network' }
  | { kind: 'server' }
  | { kind: 'signed_out' }
  | { kind: 'rejected'; code: string };

export interface Notice {
  key: string;
  args: Record<string, string | number>;
}

export interface QueueItem {
  id: string;
  title: string;
  started_at: string;
  duration_s: number;
  size_bytes: number | null;
  status: Status;
  reason: Reason | null;
  done: number;
  total: number;
  server_status: string | null;
  meeting_url: string | null;
  active: boolean;
  blocked: Blocked | null;
  local_error: string | null;
  can_save: boolean;
  recovered: boolean;
  gaps: number;
}

export type Blocked =
  | { kind: 'other_host'; host: string }
  | { kind: 'other_user'; email: string }
  | { kind: 'no_owner' };

export interface DamagedEntry {
  id: string;
  error: string;
  has_audio: boolean;
}

export interface ModelView {
  id: string;
  label: string;
  size: number;
  downloaded: boolean;
  download: { done: number; total: number; failed: boolean } | null;
}

export interface Snapshot {
  phase: 'setup' | 'connecting' | 'ready';
  host: string | null;
  host_label: string | null;
  pairing_code: string | null;
  connect_error: Notice | null;
  connection: {
    product_name: string;
    theme_accent: string;
    theme_primary: string;
    user_name: string;
    device_name: string;
  } | null;
  signed_out: boolean;
  language: 'en' | 'da';
  permissions: { microphone: Permission; system_audio: Permission };
  permissions_asked: boolean;
  recording: {
    id: string;
    title: string;
    started_at: string;
    elapsed_s: number;
    sources: { microphone: string; system_audio: string };
    stopping: boolean;
    starting: boolean;
  } | null;
  queue: QueueItem[];
  online: boolean;
  live: { enabled: boolean; model: string; models: ModelView[]; hidden: boolean; running: boolean };
  ask: QueueItem | null;
  notice: Notice | null;
  damaged: DamagedEntry[];
  version: string;
}

export interface LiveUpdate {
  state: 'loading' | 'listening' | 'paused' | 'needs_model' | 'error' | 'stopped';
  lines: string[];
  partial: string;
}
