import process from 'process'

type Socket = import('ws').WebSocket
type SocketServer = import('ws').Server & {
    readonly readyState: Socket['readyState']
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
}
type IncomingMessage = import('http').IncomingMessage & { peerId?: string }

type SnapDropCommonMessage = {
    type: 'disconnect' | 'pong' | 'peer' | 'display-name' | 'peer-joined'
}

type SnapDropMessageType = 'disconnect' | 'pong' | 'peer' | 'display-name' | 'peer-joined'

type SnapDropOutgoingMessages = {
    'peer-joined': {
        peer: ReturnType<Peer['getInfo']>
    },
    'display-name': {
        message: {
            displayName: string
            deviceName: string
        }
    }
    peers: {
        peers: ReturnType<Peer['getInfo']>[]
    }
    disconnect: {
    }
    pong: {
    }
}

type SnapDropOutgoingMessage<T extends SnapDropMessageType> = { type: T } & T extends 'peer-joined'
    ? SnapDropOutgoingMessages['peer-joined']
    : T extends 'display-name'
    ? SnapDropOutgoingMessages['display-name']
    : T extends 'peers'
    ? SnapDropOutgoingMessages['peers']
    : T extends 'disconnect'
    ? SnapDropOutgoingMessages['disconnect']
    : T extends 'pong'
    ? SnapDropOutgoingMessages['pong']
    : never

type SnapDropIncomingMessage = { to: string } & SnapDropCommonMessage

const omit = <T extends any, K extends (keyof T)[]>(keys: K, obj: T): Omit<T, K[number]> => {
    return Object
        .entries(obj)
        .reduce((acc, [key, value]) => ({
            ...acc,
            ...keys.includes(key as keyof T) ? {} : { [key]: value }
        }), {} as Omit<T, K[number]>)
}

const hashCode = (str: string) => {
    var hash = 0, i, chr;
    for (i = 0; i < str.length; i++) {
      chr   = str.charCodeAt(i);
      hash  = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

// Handle SIGINT
process.on('SIGINT', () => {
  console.info("SIGINT Received, exiting...")
  process.exit(0)
})

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info("SIGTERM Received, exiting...")
  process.exit(0)
})

const parser = require('ua-parser-js');
const { uniqueNamesGenerator, animals, colors } = require('unique-names-generator');

class SnapdropServer {

    private _wss: SocketServer
    private _rooms: { [roomId: string]: { [peerId: string]: Peer } }

    constructor(port: number | string) {
        const WebSocket = require('ws');
        this._wss = new WebSocket.Server({ port: port });
        this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));
        this._wss.on('headers', (headers, response) => this._onHeaders(headers, response as IncomingMessage));

        this._rooms = {};

        console.log('Snapdrop is running on port', port);
    }

    _onConnection(peer: Peer) {
        this._joinRoom(peer);
        peer.socket.on('message', (message: string) => this._onMessage(peer, message));
        peer.socket.on('error', console.error);
        this._keepAlive(peer);

        // send displayName
        this._send(peer, {
            type: 'display-name',
            message: {
                displayName: peer.name.displayName,
                deviceName: peer.name.deviceName
            }
        });
    }

    _onHeaders(headers: string[], response: IncomingMessage) {
        if (response.headers.cookie && response.headers.cookie.indexOf('peerid=') > -1) return;
        response.peerId = Peer.uuid();
        headers.push('Set-Cookie: peerid=' + response.peerId + "; SameSite=Strict; Secure");
    }

    _onMessage(sender: Peer, message: string) {
        // Try to parse message 
        try {
            JSON.parse(message);
        } catch (e) {
            return; // TODO: handle malformed JSON
        }
        const parsedMessage: SnapDropIncomingMessage = JSON.parse(message)

        switch (parsedMessage.type) {
            case 'disconnect':
                this._leaveRoom(sender);
                break;
            case 'pong':
                sender.lastBeat = Date.now();
                break;
        }

        // relay message to recipient
        if (parsedMessage.to && this._rooms[sender.ip]) {
            const recipientId = parsedMessage.to; // TODO: sanitize
            const recipient = this._rooms[sender.ip][recipientId];
            // delete parsedMessage.to;
            // // add sender id
            // parsedMessage.sender = sender.id;

            this._send(recipient, {
                ...omit(['to'], parsedMessage),
                sender: sender.id
            });
            return;
        }
    }

    _joinRoom(peer: Peer) {
        // if room doesn't exist, create it
        if (!this._rooms[peer.ip]) {
            this._rooms[peer.ip] = {};
        }

        // notify all other peers
        for (const otherPeerId in this._rooms[peer.ip]) {
            const otherPeer = this._rooms[peer.ip][otherPeerId];
            this._send(otherPeer, {
                type: 'peer-joined',
                peer: peer.getInfo()
            });
        }

        // notify peer about the other peers
        const otherPeers = [];
        for (const otherPeerId in this._rooms[peer.ip]) {
            otherPeers.push(this._rooms[peer.ip][otherPeerId].getInfo());
        }

        this._send(peer, {
            type: 'peers',
            peers: otherPeers
        });

        // add peer to room
        this._rooms[peer.ip][peer.id] = peer;
    }

    _leaveRoom(peer: Peer) {
        if (!this._rooms[peer.ip] || !this._rooms[peer.ip][peer.id]) return;
        this._cancelKeepAlive(this._rooms[peer.ip][peer.id]);

        // delete the peer
        delete this._rooms[peer.ip][peer.id];

        peer.socket.terminate();
        //if room is empty, delete the room
        if (!Object.keys(this._rooms[peer.ip]).length) {
            delete this._rooms[peer.ip];
        } else {
            // notify all other peers
            for (const otherPeerId in this._rooms[peer.ip]) {
                const otherPeer = this._rooms[peer.ip][otherPeerId];
                this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
            }
        }
    }

    _send<T extends SnapDropMessageType>(peer: Peer, message: SnapDropOutgoingMessage<T>) {
        if (!peer) return;
        if (this._wss.readyState !== this._wss.OPEN) return;
        const serializedMessage = JSON.stringify(message);
        peer.socket.send(serializedMessage, _ => '');
    }

    _keepAlive(peer: Peer) {
        this._cancelKeepAlive(peer);
        var timeout = 30000;
        if (!peer.lastBeat) {
            peer.lastBeat = Date.now();
        }
        if (Date.now() - peer.lastBeat > 2 * timeout) {
            this._leaveRoom(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
    }

    _cancelKeepAlive(peer: Peer) {
        if (peer && peer.timerId) {
            clearTimeout(peer.timerId);
        }
    }
}



class Peer {
    public socket: Socket
    public rtcSupported: boolean
    public timerId: number | NodeJS.Timeout
    public lastBeat: number
    public name: {
        model: string,
        os: string,
        browser: string,
        type: string,
        deviceName: string,
        displayName: string
    }
    public ip: string
    public id: string

    constructor(socket: Socket, request: IncomingMessage) {
        // set socket
        this.socket = socket;


        // set remote ip
        this._setIP(request);

        // set peer id
        this._setPeerId(request)
        // is WebRTC supported ?
        this.rtcSupported = request.url.indexOf('webrtc') > -1;
        // set name 
        this._setName(request);
        // for keepalive
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setIP(request: IncomingMessage) {
        if (request.headers['x-forwarded-for']) {
            this.ip = (request.headers['x-forwarded-for'] as string).split(/\s*,\s*/)[0];
        } else {
            this.ip = request.connection.remoteAddress;
        }
        // IPv4 and IPv6 use different values to refer to localhost
        if (this.ip == '::1' || this.ip == '::ffff:127.0.0.1') {
            this.ip = '127.0.0.1';
        }
    }

    _setPeerId(request: IncomingMessage) {
        if (request.peerId) {
            this.id = request.peerId;
        } else {
            this.id = request.headers.cookie.replace('peerid=', '');
        }
    }

    toString() {
        return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`
    }

    _setName(req: IncomingMessage) {
        let ua = parser(req.headers['user-agent']);


        let deviceName = '';
        
        if (ua.os && ua.os.name) {
            deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
        }
        
        if (ua.device.model) {
            deviceName += ua.device.model;
        } else {
            deviceName += ua.browser.name;
        }

        if(!deviceName)
            deviceName = 'Unknown Device';

        const displayName = uniqueNamesGenerator({
            length: 2,
            separator: ' ',
            dictionaries: [colors, animals],
            style: 'capital',
            seed: hashCode(this.id)
        })

        this.name = {
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
            deviceName,
            displayName
        };
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            rtcSupported: this.rtcSupported
        }
    }

    // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    static uuid() {
        return crypto.randomUUID()
    };
}


new SnapdropServer(process.env.PORT || 3000);
