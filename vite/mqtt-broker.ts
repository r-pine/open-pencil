import type { Plugin } from 'vite'

const PUBLIC_BROKERS = [
  'public.cloud.shiftr.io',
  'broker.emqx.io',
  'broker.hivemq.com',
  'test.mosquitto.org'
]

/**
 * One live socket per broker URL.
 *
 * mqtt.js opens another WebSocket on each reconnect while the previous handshake is still
 * pending. Closing an OPEN socket from here is worse: the client then writes PINGREQ onto a
 * socket Chrome has already moved to CLOSING, which is the red "WebSocket is already in
 * CLOSING or CLOSED state" line. Pending handshakes are the only ones this closes. send()
 * is a no-op unless the socket is OPEN, so a late ping cannot throw.
 */
const SOCKET_CAP = `function openPencilMqttSocket(url, protocols) {
	const sockets = openPencilMqttSocket.sockets ?? (openPencilMqttSocket.sockets = new Map());
	const previous = sockets.get(url);
	if (previous && previous.readyState === 0) {
		try { previous.close(); } catch (err) {}
	}
	const socket = new WebSocket(url, protocols);
	const send = socket.send.bind(socket);
	socket.send = (data) => {
		if (socket.readyState !== 1) return;
		try { send(data); } catch (err) {}
	};
	sockets.set(url, socket);
	socket.addEventListener("close", () => {
		if (sockets.get(url) === socket) sockets.delete(url);
	});
	return socket;
}
`

/** Drops Trystero's public MQTT clouds and caps reconnect sockets in the bundled client. */
export function selfHostedMqttBrokerPlugin(): Plugin {
  return {
    name: 'openpencil-self-hosted-mqtt',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@trystero-p2p/mqtt') || !id.includes('index.mjs')) return null
      if (!code.includes('defaultRelayUrls')) return null

      let next = code.replace(
        /const defaultRelayUrls = \[[\s\S]*?\]\.map\(\(url\) => "wss:\/\/" \+ url\);/,
        'const defaultRelayUrls = [];'
      )
      next = next.replace(
        /mqtt\.connect\(url, \{\s*queueQoSZero: false,\s*resubscribe: false\s*\}\)/,
        `mqtt.connect(url, {
			queueQoSZero: false,
			resubscribe: false,
			keepalive: 20,
			reconnectPeriod: 5000,
			connectTimeout: 20000,
			reschedulePings: true,
			timerVariant: "native",
			createWebsocket: openPencilMqttSocket
		})`
      )
      // worker-timers (mqtt.js default in the browser) can deliver several interval ticks
      // before PINGRESP returns, so KeepaliveManager counts past 2 and kills a socket that
      // just got CONNACK. Native setInterval waits the real delay. Timeouts stay off the
      // console: App's window error handler turns an uncaught report into a red toast.
      next = next.replace(
        '.on("error", console.error)',
        `.on("error", (err) => {
			const message = String(err && err.message || "");
			if (message === "Keepalive timeout" || message === "connack timeout") return;
			console.error(err);
		})`
      )
      if (!next.includes('function openPencilMqttSocket')) {
        next = next.replace('const defaultRedundancy = 4;', `${SOCKET_CAP}const defaultRedundancy = 4;`)
      }

      for (const host of PUBLIC_BROKERS) {
        if (next.includes(host)) {
          this.error(`Public MQTT broker ${host} is still in the Trystero MQTT module`)
        }
      }
      if (!next.includes('createWebsocket: openPencilMqttSocket')) {
        this.error('Failed to cap Trystero MQTT websocket reconnects')
      }
      if (!next.includes('timerVariant: "native"')) {
        this.error('Failed to pin Trystero MQTT keepalive to native timers')
      }
      if (next.includes('.on("error", console.error)')) {
        this.error('Failed to quiet Trystero MQTT background timeouts')
      }
      return { code: next, map: null }
    }
  }
}
