import { receive, store, notify, type Action, type ServerMessage } from './store';
export type Command = { type: 'inspect.result'; payload: { lead_id: string; reached: boolean; collided: boolean; found: boolean | null } } | { type: 'mission.control'; payload: { cmd: 'start' | 'pause' | 'reset'; seed?: number } } | { type: 'lead.approve'; payload: { lead_id: string } } | { type: 'lead.override'; payload: { lead_id: string; action: Action } };
export type InspectionRequest = Extract<ServerMessage, { type: 'inspect.request' }>['payload'];
let inspectionHandler: ((request: InspectionRequest) => void) | undefined;
export function onInspectionRequest(handler: (request: InspectionRequest) => void) { inspectionHandler = handler; }
let socket: WebSocket;
export function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/mission`);
  socket.onopen = () => { store.connected = true; notify('connection'); };
  socket.onmessage = event => { try { const message = JSON.parse(event.data) as ServerMessage; receive(message); if (message.type === 'inspect.request') inspectionHandler?.(message.payload); } catch { store.error = 'Could not read the server update.'; notify('error'); } };
  socket.onclose = () => { store.connected = false; notify('connection'); window.setTimeout(connect, 1500); };
  socket.onerror = () => socket.close();
}
export function send(command: Command) {
  if (socket?.readyState === WebSocket.OPEN) { store.error = ''; socket.send(JSON.stringify(command)); }
  else { store.error = 'Server disconnected. Reconnecting…'; notify('error'); }
}
