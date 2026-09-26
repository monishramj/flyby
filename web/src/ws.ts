import { receive, store, notify, type Action, type ServerMessage } from './store';
type Command = { type: 'mission.control'; payload: { cmd: 'start' | 'pause' | 'reset'; seed?: number } } | { type: 'lead.approve'; payload: { lead_id: string } } | { type: 'lead.override'; payload: { lead_id: string; action: Action } };
let socket: WebSocket;
export function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/mission`);
  socket.onopen = () => { store.connected = true; notify('connection'); };
  socket.onmessage = event => { try { receive(JSON.parse(event.data) as ServerMessage); } catch { store.error = 'Could not read the server update.'; notify('error'); } };
  socket.onclose = () => { store.connected = false; notify('connection'); window.setTimeout(connect, 1500); };
  socket.onerror = () => socket.close();
}
export function send(command: Command) {
  if (socket?.readyState === WebSocket.OPEN) { store.error = ''; socket.send(JSON.stringify(command)); }
  else { store.error = 'Server disconnected. Reconnecting…'; notify('error'); }
}
