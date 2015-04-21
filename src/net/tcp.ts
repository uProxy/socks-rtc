/// <reference path='../../../third_party/typings/es6-promise/es6-promise.d.ts' />
/// <reference path='../../../third_party/freedom-typings/freedom-common.d.ts' />
/// <reference path='../../../third_party/freedom-typings/freedom-module-env.d.ts' />
/// <reference path='../../../third_party/freedom-typings/tcp-socket.d.ts' />

import logging = require('../../../third_party/uproxy-lib/logging/logging');
import handler = require('../../../third_party/uproxy-lib/handler/queue');
import net = require('./net.types');

var log :logging.Log = new logging.Log('tcp');

// Indicates how a socket (server or client) terminated.
export enum SocketCloseKind {
  WE_CLOSED_IT,
  REMOTELY_CLOSED,
  NEVER_CONNECTED,
  UNKOWN
}

export interface ConnectionInfo {
  bound  ?:net.Endpoint;
  remote ?:net.Endpoint;
}

// Maximum per-server number of TCP connections.
var DEFAULT_MAX_CONNECTIONS = 1048576;

// Public only for unit tests.
export function endpointOfSocketInfo(info:freedom_TcpSocket.SocketInfo)
    : ConnectionInfo {
  var retval :ConnectionInfo = {};
  if (typeof info.localAddress == 'string' &&
      typeof info.localPort == 'number') {
    retval.bound = {
      address: info.localAddress,
      port: info.localPort
    };
  }
  if (typeof info.peerAddress == 'string' &&
      typeof info.peerPort == 'number') {
    retval.remote = {
      address: info.peerAddress,
      port: info.peerPort
    };
  }
  return retval;
}

// Closes a socket, along with its freedomjs interface object.
function destroyFreedomSocket_(socket:freedom_TcpSocket.Socket) : Promise<void> {
  // Note:
  //   freedom['core.tcpsocket'].close != freedom['core.tcpsocket']().close
  // The former destroys the freedom interface & communication channels.
  // The latter is a method on the constructed interface object that is on
  // the instance of the freedomjs TCP socket API.
  var destroy = () => {
    freedom['core.tcpsocket'].close(socket);
  };
  return socket.close().then(destroy, (e:Error) => {
    destroy();
    return e;
  });
}

// Promise and handler queue-based TCP server with freedomjs sockets.
// TODO: protection against multiple calls to methods such as listen
export class Server {
  private socket_ :freedom_TcpSocket.Socket;

  // Active connections to the server.
  // TODO: index by connectionId rather than socketID
  private connections_ :{[socketId:number] : Connection} = {};

  public connectionsQueue :handler.Queue<Connection, void> =
      new handler.Queue<Connection, void>();

  private isListening_ :boolean = false;

  private fulfillListening_ :(endpoint:net.Endpoint) => void;
  private rejectListening_ :(e:Error) => void;

  private onceListening_ = new Promise<net.Endpoint>((F, R) => {
    this.fulfillListening_ = F;
    this.rejectListening_ = R;
  });

  private isShutdown_ :boolean = false;

  private fulfillShutdown_ :(kind:SocketCloseKind) => void;

  private onceShutdown_ = new Promise<SocketCloseKind>((F, R) => {
    this.fulfillShutdown_ = F;
  });

  constructor(private endpoint_ :net.Endpoint,
      private maxConnections_ :number = DEFAULT_MAX_CONNECTIONS) {
    this.onceListening_.then((unused:any) => {
      this.isListening_ = true;
    }, (e:Error) => {
      this.fulfillShutdown_(SocketCloseKind.NEVER_CONNECTED);
    });

    this.onceShutdown_.then((unused:any) => {
      this.isShutdown_ = true;
    });

    this.socket_ = freedom['core.tcpsocket']();
    this.socket_.on('onConnection', this.onConnectionHandler_);
    this.socket_.on('onDisconnect', this.onDisconnectHandler_);
  }

  // Invoked when the socket terminates.
  private onDisconnectHandler_ = (info:freedom_TcpSocket.DisconnectInfo) : void => {
    log.debug('disconnected: %1', JSON.stringify(info));
    if (info.errcode === 'SUCCESS') {
      this.fulfillShutdown_(SocketCloseKind.WE_CLOSED_IT);
    } else {
      // TODO: investigate which other values occur
      this.fulfillShutdown_(SocketCloseKind.UNKOWN);
    }
  }

  // Listens for connections, returning onceListening.
  // Should only be called once.
  public listen = () : Promise<net.Endpoint> => {
    this.socket_.listen(this.endpoint_.address,
        this.endpoint_.port).then(this.socket_.getInfo).then(
        (info:freedom_TcpSocket.SocketInfo) => {
      this.endpoint_ = {
        address: info.localAddress,
        port: info.localPort
      };
      this.fulfillListening_(this.endpoint_);
    }).catch((e:Error) => {
      this.rejectListening_(new Error('failed to listen: ' + e.message));
    });

    return this.onceListening_;
  }

  // Invoked each time a new connection is established with the server.
  private onConnectionHandler_ = (
      acceptValue:freedom_TcpSocket.ConnectInfo) : void => {
    log.debug('new connection');
    var socketId = acceptValue.socket;

    if (this.connectionsCount() >= this.maxConnections_) {
      log.warn('hit maximum connections count, dropping new connection');
      destroyFreedomSocket_(freedom['core.tcpsocket'](socketId));
      return;
    }

    var connection = new Connection({
      existingSocketId: socketId
    });
    this.connections_[socketId] = connection;

    var discard = () => {
      delete this.connections_[socketId];
      log.debug('discarded connection (%1 remaining)', this.connectionsCount());
    };
    connection.onceClosed.then(discard, (e:Error) => {
      log.error('connection %1 rejected on close: %2', socketId, e.message);
      discard();
    });

    this.connectionsQueue.handle(connection);
  }

  // Closes the server socket then closes all active connections.
  // Equivalent to calling stopListening followed by closeAll.
  public shutdown = () : Promise<void> => {
    log.debug('shutdown');
    // This order is important: make sure no new connections happen while
    // we're trying to close all the connections.
    return this.stopListening().then(this.closeAll);
  }

  // Closes the server socket, preventing any new connections.
  // Does not affect active connections to the server.
  public stopListening = () : Promise<void> => {
    log.debug('closing socket, no new connections will be accepted');
    return destroyFreedomSocket_(this.socket_);
  }

  // Closes all active connections.
  public closeAll = () : Promise<void> => {
    log.debug('closing all connections');

    var promises :Promise<SocketCloseKind>[] = [];
    for (var socketId in this.connections_) {
      var connection = this.connections_[socketId];
      promises.push(connection.close());
    }

    return Promise.all(promises).then((unused:any) => {});
  }

  // Returns all active connections.
  public connections = () : Connection[] => {
    var connections : Connection[] = [];
    for (var i in this.connections_) {
      connections.push(this.connections_[i]);
    }
    return connections;
  }

  // Returns the number of the active connections.
  public connectionsCount = () => {
    return Object.keys(this.connections_).length;
  }

  // Returns true iff the promise returned by onceListening has fulfilled.
  public isListening = () : boolean => {
    return this.isListening_;
  };

  // Returns a promise which fulfills once the socket is accepting
  // connections and rejects if there is any error creating the socket
  // or listening for connections.
  public onceListening = () : Promise<net.Endpoint> => {
    return this.onceListening_;
  }

  // Returns true iff the promise returned by onceShutdown has fulfilled.
  public isShutdown = () : boolean => {
    return this.isShutdown_;
  }

  // Returns a promise which fulfills once the socket has stopped
  // accepting new connections, or the call to listen has failed.
  public onceShutdown = () : Promise<SocketCloseKind> => {
    return this.onceShutdown_;
  }

  public toString = () : string => {
    var s = 'Tcp.Server(' + JSON.stringify(this.endpoint_) +
        ') ' + this.connectionsCount() + ' connections: {';
    for (var socketId in this.connections_) {
      s += '  ' + this.connections_[socketId].toString() + '\n';
    }
    return s += '}';
  }
}

// Tcp.Connection - Manages up a single TCP connection.
export class Connection {
  // Unique identifier for each connection.
  private static globalConnectionId_ :number = 0;

  // Promise for when this connection is closed.
  public onceConnected :Promise<ConnectionInfo>;
  public onceClosed :Promise<SocketCloseKind>;
  // Queue of data to be handled, and the capacity to set a handler and
  // handle the data.
  public dataFromSocketQueue :handler.Queue<ArrayBuffer,void>;
  public dataToSocketQueue :handler.Queue<ArrayBuffer, freedom_TcpSocket.WriteInfo>;

  // Public unique connectionId.
  public connectionId :string;

  // isClosed() === state_ === Connection.State.CLOSED iff onceClosed
  // has been rejected or fulfilled. We use isClosed to ensure that we only
  // fulfill/reject the onceDisconnectd once.
  private state_ :Connection.State;
  // The underlying Freedom TCP socket.
  private connectionSocket_ :freedom_TcpSocket.Socket;
  // A private function called to invoke fullfil onceClosed.
  private fulfillClosed_ :(reason:SocketCloseKind)=>void;

  // A TCP connection for a given socket.
  constructor(connectionKind:Connection.Kind, private startPaused_?:boolean) {
    this.connectionId = 'N' + Connection.globalConnectionId_++;

    this.dataFromSocketQueue = new handler.Queue<ArrayBuffer,void>();
    this.dataToSocketQueue =
        new handler.Queue<ArrayBuffer,freedom_TcpSocket.WriteInfo>();

    if(Object.keys(connectionKind).length !== 1) {
      //log.error(this.connectionId + ': Bad New Tcp Connection Kind:' +
      //       JSON.stringify(connectionKind));
      this.state_ = Connection.State.ERROR;
      this.onceConnected =
          Promise.reject(new Error(
              this.connectionId + 'Bad New Tcp Connection Kind:' +
              JSON.stringify(connectionKind)));
      this.onceClosed = Promise.resolve(SocketCloseKind.NEVER_CONNECTED);
      return;
    }

    if(connectionKind.existingSocketId) {
      // If we already have an open socket; i.e. from a previous tcp listen.
      // So we get a handler to the old freedom socket.
      this.connectionSocket_ =
          freedom['core.tcpsocket'](connectionKind.existingSocketId);
      this.onceConnected =
          this.connectionSocket_.getInfo().then(endpointOfSocketInfo);
      this.state_ = Connection.State.CONNECTED;
      this.connectionId = this.connectionId + '.A' +
          connectionKind.existingSocketId;
    } else if (connectionKind.endpoint) {
      // Create a new tcp socket to the given endpoint.
      this.connectionSocket_ = freedom['core.tcpsocket']();
      // We don't declare ourselves connected until we know the IP address to
      // which we have connected.  To speed this process up, we immediately
      // pause the socket as soon as it's connected, so that CPU time is not
      // wasted sending events that we can't pass on until getInfo returns.
      this.onceConnected =
          this.connectionSocket_
              .connect(connectionKind.endpoint.address,
                       connectionKind.endpoint.port)
              .then(this.pause)
              .then(this.connectionSocket_.getInfo)
              .then((info:freedom_TcpSocket.SocketInfo) => {
                if (!this.startPaused_) {
                  this.resume();
                }
                return endpointOfSocketInfo(info);
              })
      this.state_ = Connection.State.CONNECTING;
      this.onceConnected
          .then(() => {
            // We need this guard because the getInfo call is async and a
            // close may happen affter the freedom socket connects and the
            // getInfo completes.
            if(this.state_ !== Connection.State.CLOSED) {
              this.state_ = Connection.State.CONNECTED;
            }
          });
    } else {
      throw(new Error(this.connectionId +
          ': Should be impossible connectionKind' +
          JSON.stringify(connectionKind)));
    }

    // Use the dataFromSocketQueue handler for data from the socket.
    this.connectionSocket_.on('onData',
        (readInfo:freedom_TcpSocket.ReadInfo) : void => {
      this.dataFromSocketQueue.handle(readInfo.data);
    });

    this.onceClosed = new Promise<SocketCloseKind>((F, R) => {
      this.fulfillClosed_ = F;
    });

    // Once we are connected, we start sending data to the underlying socket.
    // |dataToSocketQueue| allows a class using this connection to start
    // queuing data to be send to the socket.
    this.onceConnected.then(() => {
      this.dataToSocketQueue.setHandler(this.connectionSocket_.write);
    });
    this.onceConnected.catch((e:Error) => {
      this.fulfillClosed_(SocketCloseKind.NEVER_CONNECTED);
    });

    this.connectionSocket_.on('onDisconnect', this.onDisconnectHandler_);
  }

  // Receive returns a promise for exactly the next |ArrayBuffer| of data.
  public receiveNext = () : Promise<ArrayBuffer> => {
    return new Promise((F,R) => {
      this.dataFromSocketQueue.setSyncNextHandler(F).catch(R);
    });
  }

  // Invoked when the socket is closed for any reason.
  // Fulfills onceClosed.
  private onDisconnectHandler_ = (info:freedom_TcpSocket.DisconnectInfo) : void => {
    log.debug('%1: onDisconnect: %2', [
        this.connectionId,
        JSON.stringify(info)]);

    if (this.state_ === Connection.State.CLOSED) {
      log.warn('%1: Got onDisconnect in closed state', [this.connectionId]);
      return;
    }

    this.state_ = Connection.State.CLOSED;
    this.dataToSocketQueue.stopHandling();
    this.dataToSocketQueue.clear();

    // CONSIDER: can this happen after a onceConnected promise rejection? if so,
    // do we want to preserve the SocketCloseKind.NEVER_CONNECTED result for
    // onceClosed?
    destroyFreedomSocket_(this.connectionSocket_).then(() => {
      if (info.errcode === 'SUCCESS') {
        this.fulfillClosed_(SocketCloseKind.WE_CLOSED_IT);
      } else if (info.errcode === 'CONNECTION_CLOSED') {
        this.fulfillClosed_(SocketCloseKind.REMOTELY_CLOSED);
      } else {
        this.fulfillClosed_(SocketCloseKind.UNKOWN);
      }
    });
  }

  public pause = () => {
    this.connectionSocket_.pause();
  }

  public resume = () => {
    this.connectionSocket_.resume();
  }

  // This is called to close the underlying socket. This fulfills the
  // disconnect Promise `onceDisconnected`.
  public close = () : Promise<SocketCloseKind> => {
    log.debug('%1: close', [this.connectionId]);

    if (this.state_ === Connection.State.CLOSED) {
      log.debug('%1: close called when already closed', [
          this.connectionId]);
    } else {
      this.connectionSocket_.close();
    }

    // The onDisconnect handler (which should only
    // be invoked once) actually stops handling, fulfills
    // onceClosed, etc.
    return this.onceClosed;
  }

  // Boolean function to check if this connection is closed;
  public isClosed = () : boolean => {
    return this.state_ === Connection.State.CLOSED;
  };
  public getState = () : Connection.State => {
    return this.state_;
  };

  /**
   * Sends a message that is pre-formatted as an arrayBuffer.
   */
  public send = (msg :ArrayBuffer) : Promise<freedom_TcpSocket.WriteInfo> => {
    return this.dataToSocketQueue.handle(msg);
  }

  public toString = () => {
    return 'Tcp.Connection(' + this.connectionId + ':' + Connection.State[this.state_] + ')';
  }

}  // class Tcp.Connection

// Static stuff for the Connection class.
export module Connection {
  // Exactly one of the arguments must be specified.
  export interface Kind {
    // To wrap up a connection for an existing socket
    existingSocketId ?:number;
    // TO create a new TCP connection to this target address and port.
    endpoint         ?:net.Endpoint;
  }

  // Describes the state of a connection.
  export enum State {
    ERROR, // Cannot change state.
    CONNECTING, // Can change to ERROR or CONNECTED.
    CONNECTED, // Can change to ERROR or CLOSED.
    CLOSED // Cannot change state.
  }
} // module Connection
