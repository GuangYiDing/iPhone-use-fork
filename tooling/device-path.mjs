// Opens one device port on the configured iPhone over the path the transport
// allows. USB uses usbmux's cable record. Wi-Fi uses the CoreDevice tunnel
// that Xcode keeps to the phone while the runner's test session is active: an
// encrypted, pairing-authenticated link whose phone-side address devicectl
// reports. The relay is Shelley's WDA tunnel on this Mac's loopback: the phone's
// WDA keeps an encrypted connection to Shelley's relay server wherever the phone
// is, and Shelley forwards every connection to that port into WDA. usbmux
// "Network" records are never used: they are plain TCP on the LAN and disappear
// once the phone locks.
import {execFile} from 'node:child_process';
import net from 'node:net';
import {Usbmux, getDefaultSocket} from 'appium-ios-device/build/lib/usbmux/index.js';

export const TRANSPORTS = ['auto', 'usb', 'network', 'relay'];
export const RELAY_PATH = 'Shelley relay tunnel';
const CONNECT_TIMEOUT_MS = 5000;
const RELAY_HOST = '127.0.0.1';
// Where Shelley's tunnel listens on this Mac, and the one device port it
// reaches: the phone end connects every stream to WDA's own port, so other
// device ports (the MJPEG stream) are not available through it.
export const RELAY_PORT = portFromEnvironment('WDA_RELAY_PORT', 18101);
export const RELAY_DEVICE_PORT = portFromEnvironment('WDA_RELAY_DEVICE_PORT', 8100);
// Shelley's tunnel accepts and closes at once while no phone WDA is connected
// through the relay, or when the phone could not open the stream. Only the
// forward can see that, after the connection has been handed over.
export const RELAY_CLOSED_EARLY = `${RELAY_PATH} closed the connection before answering: no iPhone WDA is connected `
  + "through Shelley's relay (shelley-cli wda-launch), or the phone refused the stream";

function portFromEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const number = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(number >= 1024 && number <= 65535)) throw new Error(`${name} must be a port between 1024 and 65535.`);
  return number;
}

export function parseTransport(value) {
  if (!TRANSPORTS.includes(value)) throw new Error(`Transport must be one of: ${TRANSPORTS.join(', ')}.`);
  return value;
}

// The cable tunnel, or null when usbmux lists no cable for this phone.
async function openUsb(udid, port) {
  const mux = new Usbmux(await getDefaultSocket());
  let connected = false;
  try {
    const record = (await mux.listDevices()).find(item => item?.Properties?.SerialNumber === udid
      && item.Properties.ConnectionType === 'USB');
    if (!record) return null;
    try {
      // Success turns this usbmux control socket into the device tunnel.
      const socket = await mux.connect(record.Properties.DeviceID, port);
      connected = true;
      return socket;
    } catch (error) {
      throw new Error(`USB connection to device port ${port} failed: ${error?.message ?? error}`);
    }
  } finally {
    if (!connected) mux.close();
  }
}

function listCoreDevices() {
  return new Promise((resolve, reject) => {
    execFile('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--timeout', '5', '--json-output', '-'],
      {timeout: 10000, maxBuffer: 4 * 1024 * 1024}, (error, stdout) => {
        if (error) { reject(new Error(`devicectl failed: ${error.message}`)); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('devicectl returned invalid JSON')); }
      });
  });
}

// The tunnel exists only while a CoreDevice session (the runner's xcodebuild)
// is active, so it is looked up again for every connection (~70 ms).
export async function findTunnel(udid) {
  let document;
  try { document = await listCoreDevices(); } catch (error) { return {reason: error.message}; }
  const devices = document?.result?.devices;
  const device = Array.isArray(devices) ? devices.find(item => item?.hardwareProperties?.udid === udid) : undefined;
  if (!device) return {reason: 'CoreDevice does not list it'};
  const connection = device.connectionProperties ?? {};
  if (connection.tunnelState !== 'connected') return {reason: `tunnelState=${connection.tunnelState ?? 'unknown'}`};
  // An IP literal only, so the address can never trigger a name lookup.
  const address = connection.tunnelIPAddress;
  if (typeof address !== 'string' || !net.isIPv6(address)) return {reason: 'no IPv6 tunnel address'};
  return {address, link: connection.transportType ?? 'unknown'};
}

// A plain TCP connection, handed over paused like a usbmux tunnel.
function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host, port});
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.pause();
      resolve(socket);
    });
  });
}

// Why the relay cannot serve this device port, or null.
function relayPortMismatch(port) {
  return port === RELAY_DEVICE_PORT ? null
    : `the relay reaches device port ${RELAY_DEVICE_PORT} only, not ${port} (WDA_RELAY_DEVICE_PORT)`;
}

// Shelley's relay port, or an error naming the step that is missing. The tunnel
// carries one phone and does not say which, so the UDID is not checked here.
async function openRelay() {
  try {
    return await connectTcp(RELAY_HOST, RELAY_PORT);
  } catch (error) {
    throw new Error(error?.code === 'ECONNREFUSED'
      ? `nothing listens at ${RELAY_HOST}:${RELAY_PORT} (Shelley's WDA tunnel is not running: shelley-cli serve --relay)`
      : `${RELAY_HOST}:${RELAY_PORT}: ${error?.message ?? error}`);
  }
}

export async function connectDevicePort(udid, port, transport) {
  parseTransport(transport);
  if (transport === 'relay') {
    const mismatch = relayPortMismatch(port);
    if (mismatch) throw new Error(`The ${RELAY_PATH} cannot open device port ${port} (transport=relay): ${mismatch}.`);
    try {
      return {socket: await openRelay(), path: RELAY_PATH};
    } catch (error) {
      throw new Error(`No ${RELAY_PATH} (transport=relay): ${error.message}.`);
    }
  }
  if (transport !== 'network') {
    // auto prefers the cable whenever usbmux lists it: unplugging moves new
    // connections to the tunnel, plugging back in returns them to USB.
    const socket = await openUsb(udid, port);
    if (socket) return {socket, path: 'USB'};
    if (transport === 'usb') throw new Error('No USB record for the configured iPhone (transport=usb).');
  }
  const tunnel = await findTunnel(udid);
  if (!tunnel.address) {
    if (transport === 'network') throw new Error(`No CoreDevice tunnel to the configured iPhone (transport=network): ${tunnel.reason}.`);
    // auto: away from the cable and from Xcode, the relay is the last path.
    let reason = relayPortMismatch(port);
    if (!reason) {
      try {
        return {socket: await openRelay(), path: RELAY_PATH};
      } catch (error) {
        reason = error.message;
      }
    }
    throw new Error(`No USB record, CoreDevice tunnel or ${RELAY_PATH} for the configured iPhone (transport=auto): `
      + `${tunnel.reason}; ${reason}.`);
  }
  try {
    return {socket: await connectTcp(tunnel.address, port), path: `CoreDevice tunnel (${tunnel.link})`};
  } catch (error) {
    const reason = error?.code === 'ECONNREFUSED' ? 'the port is not listening yet' : (error?.message ?? String(error));
    throw new Error(`CoreDevice tunnel connection to device port ${port} failed: ${reason}`);
  }
}
