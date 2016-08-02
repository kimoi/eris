"use strict";

const Bucket = require("./util/Bucket");
const Channel = require("./core/Channel");
const Collection = require("./util/Collection");
const Endpoints = require("./Constants").Endpoints;
const EventEmitter = require("eventemitter3");
const ExtendedUser = require("./core/ExtendedUser");
const GroupChannel = require("./core/GroupChannel");
const Guild = require("./core/Guild");
const GuildIntegration = require("./core/GuildIntegration");
const HTTPS = require("https");
const Invite = require("./core/Invite");
const Message = require("./core/Message");
const MultipartData = require("./util/MultipartData");
const PermissionOverwrite = require("./core/PermissionOverwrite");
const PrivateChannel = require("./core/PrivateChannel");
const Promise = require("bluebird");
const Relationship = require("./core/Relationship");
const Role = require("./core/Role");
const Shard = require("./core/Shard");
const User = require("./core/User");
const VoiceConnection = require("./core/VoiceConnection");

/**
* Represents the main Eris client
* @extends EventEmitter
* @prop {String} token The bot user token
* @prop {Boolean?} bot Whether the bot user belongs to an OAuth2 application
* @prop {Object} options Eris options
* @prop {Object} channelGuildMap Object mapping channel IDs to guild IDs
* @prop {Collection<Shard>} shards Collection of shards Eris is using
* @prop {Collection<Guild>} guilds Collection of guilds the bot is in
* @prop {Object} privateChannelMap Object mapping user IDs to private channel IDs
* @prop {Collection<PrivateChannel>} privateChannels Collection of private channels the bot is in
* @prop {Collection<GroupChannel>} groupChannels Collection of group channels the bot is in (user accounts only)
* @prop {Collection<VoiceConnection>} voiceConnections Collection of VoiceConnections the bot has
* @prop {Object} retryAfters Object mapping endpoints to ratelimit expiry timestamps
* @prop {Object} guildShardMap Object mapping guild IDs to shard IDs
* @prop {Number} startTime Timestamp of bot ready event
* @prop {Collection<Guild>} unavailableGuilds Collection of unavailable guilds the bot is in
* @prop {Number} uptime How long in milliseconds the bot has been up for
* @prop {User} user The bot user
* @prop {Collection<User>} users Collection of users the bot sees
*/
class Client extends EventEmitter {
    /**
    * Create a Client
    * @arg {String} token bot token
    * @arg {Object} [options] Eris options (all options are optional)
    * @arg {Boolean} [options.autoReconnect=true] Have Eris autoreconnect when connection is lost
    * @arg {Boolean} [options.buckets=true] Use buckets instead of regular 429 retry
    * @arg {Boolean} [options.cleanContent=true] Whether to enable the Messages.cleanContent and Message.channelMentions properties or not
    * @arg {Boolean} [options.compress=true] Whether to request WebSocket data to be compressed or not
    * @arg {Number} [options.connectionTimeout=10000] How long in milliseconds to wait for the connection to handshake with the server
    * @arg {Object} [options.disableEvents] If disableEvents[eventName] is true, the WS event will not be processed. This can cause significant performance increase on large bots. <a href="reference.html#ws-event-names">A full list of the WS event names can be found on the docs reference page</a>
    * @arg {Boolean} [options.disableEveryone=true] When true, filter out @everyone/@here by default in createMessage/editMessage
    * @arg {Number} [options.firstShardID=0] The ID of the first shard to run for this client
    * @arg {Boolean} [options.getAllUsers=false] Get all the users in every guild. Ready time will be severely delayed
    * @arg {Number} [options.largeThreshold=250] The maximum number of offline users per guild during initial guild data transmission
    * @arg {Number} [options.lastShardID=options.maxShards - 1] The ID of the last shard to run for this client
    * @arg {Number} [options.maxShards=1] The total number of shards you want to run
    * @arg {Number} [options.messageLimit=100] The maximum size of a channel message cache
    * @arg {Boolean} [options.opusOnly=true] Whether to suppress the node-opus not found error or not
    * @arg {Number} [options.guildCreateTimeout=2000] How long in milliseconds to wait for a GULID_CREATE before "ready" is fired. Increase this value if you notice missing guilds
    * @arg {Number} [options.voiceDataTimeout=2000] Timeout when waiting for voice data (-1 for no timeout)
    * @arg {Number} [options.sequencerWait=200] How long to wait between sending potentially ratelimited requests
    * @arg {Number} [options.gatewayVersion=5] What Discord gateway versio to use (4 and 5 are supported)
    * @returns {Client} A Client object
    */
    constructor(token, options) {
        super();
        if(!token) {
            throw new Error("Token not specified");
        }

        this.options = {
            autoreconnect: true,
            buckets: true,
            cleanContent: true,
            compress: true,
            connectionTimeout: 5000,
            disableEvents: {},
            disableEveryone: true,
            firstShardID: 0,
            gatewayVersion: 6,
            getAllUsers: false,
            guildCreateTimeout: 2000,
            largeThreshold: 250,
            maxShards: 1,
            messageLimit: 100,
            opusOnly: false,
            sequencerWait: 200,
            voiceDataTimeout: 2000
        };
        if(typeof options === "object") {
            for(var property of Object.keys(options)) {
                this.options[property] = options[property];
            }
        }
        if(this.options.lastShardID === undefined) {
            this.options.lastShardID = this.options.maxShards - 1;
        }
        if(this.options.gatewayVersion === 6) {
            Endpoints.BASE_URL += "/v6";
        }

        this.token = token;
        this.ready = false;
        this.startTime = 0;
        this.userAgent = `DiscordBot (https://github.com/abalabahaha/eris, ${require("../package.json").version})`;
        this.lastReadyPacket = 0;
        this.connectQueue = [];
        this.channelGuildMap = {};
        this.shards = new Collection(Shard);
        this.groupChannels = new Collection(GroupChannel);
        this.guilds = new Collection(Guild);
        this.privateChannelMap = {};
        this.privateChannels = new Collection(PrivateChannel);
        this.retryAfters = {};
        this.guildShardMap = {};
        this.voiceConnections = new Collection(VoiceConnection);
        this.unavailableGuilds = new Collection(Guild);
        this.users = new Collection(User);
        this.buckets = {};
        if(this.options.buckets) {
            this.buckets["bot:msg:dm"] = new Bucket(5, 5000, this.options.sequencerWait);
            this.buckets["bot:msg:global"] = new Bucket(50, 10000, this.options.sequencerWait);
            this.buckets["dmsg:undefined"] = new Bucket(5, 1000, this.options.sequencerWait);
            this.buckets["msg"] = new Bucket(10, 10000, this.options.sequencerWait);
            this.buckets["username"] = new Bucket(2, 3600000, this.options.sequencerWait);
        }
    }

    get uptime() {
        return this.startTime ? Date.now() - this.startTime : 0;
    }

    validateToken() {
        if(this.bot !== undefined) {
            return Promise.resolve();
        }
        return this.getSelf().then((user) => {
            if(!user.bot) {
                this.options.maxShards = 1;
                this.options.firstShardID = this.options.lastShardID = 0;
                this.relationships = new Collection(Relationship);
            }
            this.bot = user.bot;
            this.emit("debug", `The bot user appears to be a ${this.bot ? "OAuth bot" : "user account"}`);
        });
    }

    /**
    * Tells all shards to connect. Creates shards if there aren't enough
    * @returns {Promise} Resolves when all shards are initialized
    */
    connect() {
        return this.validateToken().then(() => this.getGateway()).then(() => {
            for(var i = this.options.firstShardID; i <= this.options.lastShardID; ++i) {
                let shard = this.shards.get(i);
                if(!shard) {
                    shard = this.shards.add(new Shard(i, this));
                    shard.on("ready", () => {
                        /**
                        * Fired when a shard turns ready
                        * @event Client#shardReady
                        * @prop {Number} id The ID of the shard
                        */
                        this.emit("shardReady", shard.id);
                        if(this.ready) {
                            return;
                        }
                        for(var other of this.shards) {
                            if(!other[1].ready) {
                                return;
                            }
                        }
                        this.ready = true;
                        this.startTime = Date.now();
                        /**
                        * Fired when all shards turn ready
                        * @event Client#ready
                        */
                        this.emit("ready");
                    });
                    shard.on("resume", () => {
                        /**
                        * Fired when a shard resumes
                        * @event Client#shardResume
                        * @prop {Number} id The ID of the shard
                        */
                        this.emit("shardResume", shard.id);
                        if(this.ready) {
                            return;
                        }
                        for(var other of this.shards) {
                            if(!other[1].ready) {
                                return;
                            }
                        }
                        this.ready = true;
                        this.startTime = Date.now();
                        this.emit("ready");
                    });
                    shard.on("disconnect", (error) => {
                        /**
                        * Fired when a shard disconnects
                        * @event Client#shardDisconnect
                        * @prop {Error?} error The error, if any
                        * @prop {Number} id The ID of the shard
                        */
                        this.emit("shardDisconnect", error, shard.id);
                        if(!this.ready) {
                            return;
                        }
                        for(var other of this.shards) {
                            if(other[1].ready) {
                                return;
                            }
                        }
                        this.ready = false;
                        this.startTime = 0;
                        /**
                        * Fired when all shards disconnect
                        * @event Client#disconnect
                        */
                        this.emit("disconnect");
                    });
                }
                this.queueConnect(shard);
            }
        });
    }

    /**
    * Get the Discord websocket gateway URL.
    * @returns {Promise<String>} Resolves with the gateway URL
    */
    getGateway() {
        if(this.gatewayURL) {
            return Promise.resolve(this.gatewayURL);
        }
        return this.callAPI("GET", Endpoints.GATEWAY, true).then((data) => {
            if(data.url) {
                if(data.url.includes("?")) {
                    data.url = data.url.substring(0, data.url.indexOf("?"));
                }
                if(!data.url.endsWith("/")) {
                    data.url += "/";
                }
                this.gatewayURL = `${data.url}?encoding=json&v=${this.options.gatewayVersion}`;
                return Promise.resolve(this.gatewayURL);
            } else {
                return Promise.reject(new Error("Invalid response from gateway REST call"));
            }
        });
    }

    queueConnect(shard) {
        if(this.lastReadyPacket <= Date.now() - 5250 && !this.shards.find((shard) => shard.connecting)) {
            shard.connect();
        } else {
            this.connectQueue.push(shard);
            this.tryConnect();
        }
    }

    tryConnect() {
        if(!this.connectTimeout) {
            this.connectTimeout = setTimeout(() => {
                if(this.connectQueue.length > 0 && this.lastReadyPacket <= Date.now() - 5250 && !this.shards.find((shard) => shard.connecting)) {
                    this.connectQueue.shift().connect();
                }
                this.connectTimeout = null;
                if(this.connectQueue.length > 0) {
                    this.tryConnect();
                }
            }, Math.min(Math.max(250, Date.now() - 5250 - this.lastReadyPacket), 5250));
        }
    }

    /**
    * Disconnects all shards
    * @arg {Object?} [options] Shard disconnect options
    * @arg {String | Boolean} [options.reconnect] false means destroy everything, true means you want to reconnect in the future, "auto" will autoreconnect
    */
    disconnect(options) {
        this.ready = false;
        this.shards.forEach((shard) => {
            shard.disconnect(options);
        });
        this.connectQueue = [];
    }

    /**
    * Joins a voice channel. If joining a group call, the voice connection ID will be stored in voiceConnections as "call". Otherwise, it will be the guild ID
    * @arg {String} channelID The ID of the voice channel
    * @returns {Promise<VoiceConnection>} Resolves with an established VoiceConnection
    */
    joinVoiceChannel(channelID) {
        var channel = this.getChannel(channelID);
        if(!channel) {
            return Promise.reject(new Error("Channel not found"));
        }
        if(channel.guild && !channel.permissionsOf(this.user.id).json.voiceConnect) {
            return Promise.reject(new Error("Insufficient permission to connect to voice channel"));
        }
        var guildID = channel.guild && this.channelGuildMap[channelID] || "call";
        var connection = this.voiceConnections.get(guildID);
        if(connection) {
            connection.switchChannel(channelID);
            if(connection.ready) {
                return Promise.resolve(connection);
            }
        } else {
            connection = this.voiceConnections.add(new VoiceConnection(guildID, this.shards.get(channel.guild && this.guildShardMap[guildID] || 0)));
            connection.connect(channelID);
        }
        return new Promise((resolve, reject) => {
            var disconnectHandler, readyHandler;
            disconnectHandler = (err) => {
                connection.removeListener("ready", readyHandler);
                reject(err);
            };
            readyHandler = () => {
                connection.removeListener("disconnect", disconnectHandler);
                resolve(connection);
            };
            connection.once("ready", readyHandler);
            connection.once("disconnect", disconnectHandler);
        });
    }

    /**
    * Leaves a voice channel
    * @arg {String} channelID The ID of the voice channel
    */
    leaveVoiceChannel(channelID) {
        var channel = this.getChannel(channelID);
        if(!channel) {
            return Promise.reject(new Error("Channel not found"));
        }
        var connection = this.voiceConnections.get(channel.guild && this.channelGuildMap[channelID] || "call");
        if(connection) {
            connection.disconnect();
            this.voiceConnections.remove(connection);
        }
    }

    /**
    * Updates the bot's status (for all guilds)
    * @arg {Boolean?} [idle] Sets if the bot is idle (true) or online (false)
    * @arg {Object?} [game] Sets the bot's active game, null to clear
    * @arg {String} game.name Sets the name of the bot's active game
    * @arg {Number} [game.type] The type of game. 0 is default, 1 is Twitch, 2 is YouTube
    * @arg {String} [game.url] Sets the url of the shard's active game
    */
    editStatus(idle, game) {
        this.shards.forEach((shard) => {
            shard.editStatus(idle, game);
        });
    }

    /**
    * Updates the bot's idle status (for all guilds)
    * @arg {Boolean} idle Sets if the bot is idle (true) or online (false)
    */
    editIdle(idle) {
        this.editStatus(idle);
    }

    /**
    * Updates the bot's active game (for all guilds)
    * @arg {Object?} game Sets the bot's active game, null to clear
    * @arg {String} game.name Sets the name of the bot's active game
    * @arg {Number} [game.type] The type of game. 0 is default, 1 is Twitch, 2 is YouTube
    * @arg {String} [game.url] Sets the url of the shard's active game
    */
    editGame(game) {
        this.editStatus(null, game);
    }

    /**
    * Get a Channel object from a channelID
    * @arg {String} [channelID] The ID of the channel
    * @returns {Channel}
    */
    getChannel(channelID) {
        return this.channelGuildMap[channelID] ? this.guilds.get(this.channelGuildMap[channelID]).channels.get(channelID) : this.privateChannels.get(channelID) || this.groupChannels.get(channelID);
    }

    /**
    * Create a channel in a guild
    * @arg {String} guildID The ID of the guild to create the channel in
    * @arg {String} name The name of the channel
    * @arg {String} [type=0/"text"] The type of the channel, either 0 or 2 ("text" or "voice" respectively in gateway 5 and under)
    * @returns {Promise<Channel>}
    */
    createChannel(guildID, name, type) {
        var guild = this.guilds.get(guildID);
        if(!guild) {
            return Promise.reject(new Error(`Guild ${guildID} not found`));
        }
        return this.callAPI("POST", Endpoints.GUILD_CHANNELS(guildID), true, {
            name,
            type
        }).then((channel) => new Channel(channel, guild));
    }

    /**
    * Edit a channel's properties
    * @arg {String} channelID The ID of the channel
    * @arg {Object} options The properties to edit
    * @arg {String} [options.name] The name of the channel
    * @arg {String} [options.icon] The icon of the channel as a base64 data string (group channels only)
    * @arg {String} [options.ownerID] The ID of the channel owner (group channels only)
    * @arg {String} [options.topic] The topic of the channel (guild text channels only)
    * @arg {Number} [options.bitrate] The bitrate of the channel (guild voice channels only)
    * @arg {Number} [options.userLimit] The channel user limit (guild voice channels only)
    * @returns {Promise<Channel>}
    */
    editChannel(channelID, options) {
        var channel = this.getChannel(channelID);
        if(!channel) {
            return Promise.reject(new Error(`Channel ${channelID} not found`));
        }

        return this.callAPI("PATCH", Endpoints.CHANNEL(channelID), true, {
            name: options.name || channel.name,
            icon: channel.type === 3 ? options.icon || channel.icon : undefined,
            owner_id: channel.type === 3 ? options.ownerID || channel.ownerID : undefined,
            topic: channel.type === "text" || channel.type === 0 ? options.topic || channel.topic : undefined,
            bitrate: channel.type === "voice" || channel.type === 2 ? options.bitrate || channel.bitrate : undefined,
            user_limit: channel.type === "voice" || channel.type === 2 ? options.userLimit || channel.userLimit : undefined
        }).then((data) => {
            if(channel.guild) {
                return new Channel(data, channel.guild);
            } else {
                return new GroupChannel(data, this);
            }
        });
    }

    /**
    * Edit a guild channel's position. Note that channel position numbers are lowest on top and highest at the bottom.
    * @arg {String} guildID The ID of the guild the channel is in
    * @arg {String} channelID The ID of the channel
    * @arg {Number} position The position of the new channel
    * @returns {Promise}
    */
    editChannelPosition(guildID, channelID, position) {
        var channels = this.guilds.get(guildID).channels;
        var channel = channels.get(channelID);
        if(!channel) {
            return Promise.reject(new Error(`Channel ${channelID} not found`));
        }
        if(channel.position === position) {
            return Promise.resolve();
        }
        var min = Math.min(position, channel.position);
        var max = Math.max(position, channel.position);
        channels = channels.filter((chan) => chan.type === channel.type && min <= chan.position && chan.position <= max && chan.id !== channelID).sort((a, b) => a.position - b.position);
        if(position > channel.position) {
            channels.push(channel);
        } else {
            channels.unshift(channel);
        }
        return this.callAPI("PATCH", Endpoints.GUILD_CHANNELS(guildID), true, channels.map((channel, index) => ({
            id: channel.id,
            position: index + min
        })));
    }

    /**
    * Edit a channel's properties
    * @arg {String} channelID The ID of the channel
    * @returns {Promise<Channel>}
    */
    deleteChannel(channelID) {
        return this.callAPI("DELETE", Endpoints.CHANNEL(channelID), true);
    }

    /**
    * Send typing status in a channel
    * @arg {String} channelID The ID of the channel
    * @returns {Promise}
    */
    sendChannelTyping(channelID) {
        return this.callAPI("POST", Endpoints.CHANNEL_TYPING(channelID), true);
    }

    /**
    * Create a channel permission overwrite
    * @arg {String} channelID The ID of channel
    * @arg {String} overwriteID The ID of the overwritten user or role
    * @arg {Number} allow The permissions number for allowed permissions
    * @arg {Number} deny The permissions number for denied permissions
    * @arg {String} type The object type of the overwrite, either "member" or "role"
    * @returns {Promise<PermissionOverwrite>}
    */
    editChannelPermission(channelID, overwriteID, allow, deny, type) {
        return this.callAPI("PUT", Endpoints.CHANNEL_PERMISSION(channelID, overwriteID), true, {
            allow,
            deny,
            type
        }).then((permissionOverwrite) => new PermissionOverwrite(permissionOverwrite));
    }

    /**
    * Create a channel permission overwrite
    * @arg {String} channelID The ID of the channel
    * @arg {String} overwriteID The ID of the overwritten user or role
    * @returns {Promise}
    */
    deleteChannelPermission(channelID, overwriteID) {
        return this.callAPI("DELETE", Endpoints.CHANNEL_PERMISSION(channelID, overwriteID), true);
    }

    /**
    * Get all invites in a channel
    * @arg {String} channelID The ID of the channel
    * @returns {Promise<Invite[]>}
    */
    getChannelInvites(channelID) {
        return this.callAPI("GET", Endpoints.CHANNEL_MESSAGES(channelID), true).then((invites) => invites.map((invite) => new Invite(invite)));
    }

    /**
    * Create an invite for a channel
    * @arg {String} channelID The ID of the channel
    * @arg {Object} [options] Invite generation options
    * @arg {Number} [options.maxAge] How long the invite should last in seconds
    * @arg {Number} [options.maxUses] How many uses the invite should last for
    * @arg {Boolean} [options.temporary] Whether the invite is temporary or not
    * @arg {Boolean} [options.xkcdpass] Whether the invite is human readable or not
    * @returns {Promise<Invite>}
    */
    createInvite(channelID, options) {
        options = options || {};
        return this.callAPI("POST", Endpoints.CHANNEL_INVITES(channelID), true, {
            max_age: options.maxAge,
            max_uses: options.maxUses,
            temporary: options.temporary,
            xkcdpass: options.xkcdpass
        }).then((invite) => new Invite(invite));
    }

    /**
    * Create a gulid role
    * @arg {String} guildID The ID of the guild to create the role in
    * @returns {Promise<Role>}
    */
    createRole(guildID) {
        return this.callAPI("POST", Endpoints.GUILD_ROLES(guildID), true).then((role) => new Role(role));
    }

    /**
    * Edit a gulid role
    * @arg {String} guildID The ID of the guild the role is in
    * @arg {String} roleID The ID of the role
    * @arg {Object} options The properties to edit
    * @arg {String} [options.name] The name of the role
    * @arg {Number} [options.permissions] The role permissions number
    * @arg {Number} [options.color] The hex color of the role, in number form (ex: 0x3da5b3 or 4040115)
    * @arg {Boolean} [options.hoist] Whether to hoist the role in the user list or not
    * @returns {Promise<Role>}
    */
    editRole(guildID, roleID, options) {
        var role = this.guilds.get(guildID).roles.get(roleID);
        return this.callAPI("PATCH", Endpoints.GUILD_ROLE(guildID, roleID), true, {
            name: options.name || role.name,
            permissions: options.permissions || role.permissions,
            color: options.color,
            hoist: options.hoist
        }).then((role) => new Role(role));
    }

    /**
    * Edit a guild role's position. Note that role position numbers are highest on top and lowest at the bottom.
    * @arg {String} guildID The ID of the guild the role is in
    * @arg {String} roleID The ID of the role
    * @arg {Number} position The new position of the role
    * @returns {Promise}
    */
    editRolePosition(guildID, roleID, position) {
        if(guildID === roleID) {
            return Promise.reject(new Error("Cannot move default role"));
        }
        var roles = this.guilds.get(guildID).roles;
        var role = roles.get(roleID);
        if(!role) {
            return Promise.reject(new Error(`Role ${roleID} not found`));
        }
        if(role.position === position) {
            return Promise.resolve();
        }
        var min = Math.min(position, role.position);
        var max = Math.max(position, role.position);
        roles = roles.filter((role) => min <= role.position && role.position <= max && role.id !== roleID).sort((a, b) => a.position - b.position);
        if(position > role.position) {
            roles.push(role);
        } else {
            roles.unshift(role);
        }
        return this.callAPI("PATCH", Endpoints.GUILD_ROLES(guildID), true, roles.map((role, index) => ({
            id: role.id,
            position: index + min
        })));
    }

    /**,
    * Create a gulid role
    * @arg {String} guildID The ID of the guild to create the role in
    * @arg {String} roleID The ID of the role
    * @returns {Promise}
    */
    deleteRole(guildID, roleID) {
        return this.callAPI("DELETE", Endpoints.GUILD_ROLE(guildID, roleID), true);
    }

    /**
    * Get the prune count for a guild
    * @arg {String} guildID The ID of the guild
    * @arg {Number} days The number of days of inactivity to prune for
    * @returns {Promise<Number>} Resolves with the number of users that would be pruned
    */
    getPruneCount(guildID, days) {
        return this.callAPI("GET", Endpoints.GUILD_PRUNE(guildID), true, {
            days
        }).then((data) => data.pruned);
    }

    /**
    * Begin pruning a guild
    * @arg {String} guildID The ID of the guild
    * @arg {Number} days The number of days of inactivity to prune for
    * @returns {Promise<Number>} Resolves with the number of pruned users
    */
    pruneMembers(guildID, days) {
        return this.callAPI("POST", Endpoints.GUILD_PRUNE(guildID), true, {
            days
        }).then((data) => data.pruned);
    }

    /**
    * Get possible voice reigons for a guild
    * @arg {String} guildID The ID of the guild
    * @returns {Promise<Object[]>} Resolves with an array of voice region objects
    */
    getVoiceRegions(guildID) {
        return guildID ? this.callAPI("GET", Endpoints.GUILD_VOICE_REGIONS(guildID), true) : this.callAPI("GET", Endpoints.VOICE_REGIONS, true); // TODO parse regions
    }

    /**
    * Get info on an invite
    * @arg {String} inviteID The ID of the invite
    * @returns {Promise<Invite>}
    */
    getInvite(inviteID) {
        return this.callAPI("GET", Endpoints.INVITE(inviteID), true).then((invite) => {
            if(this.getChannel(invite.channel.id).permissionsOf(this.user.id).json.manageChannels) { // TODO verify this is the right permission
                return this.callAPI("POST", Endpoints.CHANNEL_INVITES(invite.channel.id), true, {
                    validate: inviteID
                }).then((extendedInvite) => new Invite(extendedInvite));
            }
            return new Invite(invite);
        });
    }

    /**
    * Accept an invite (not for bot accounts)
    * @arg {String} inviteID The ID of the invite
    * @returns {Promise<Invite>}
    */
    acceptInvite(inviteID) {
        return this.callAPI("POST", Endpoints.INVITE(inviteID), true).then((invite) => new Invite(invite));
    }

    /**
    * Delete an invite
    * @arg {String} inviteID The ID of the invite
    * @returns {Promise}
    */
    deleteInvite(inviteID) {
        return this.callAPI("DELETE", Endpoints.INVITE(inviteID), true);
    }

    /**
    * Get properties of the bot user
    * @returns {Promise<ExtendedUser>}
    */
    getSelf() {
        return this.callAPI("GET", Endpoints.ME, true).then((data) => new ExtendedUser(data));
    }

    /**
    * Edit properties of the bot user
    * @arg {Object} options The properties to edit
    * @arg {String} [options.username] The new username
    * @arg {String} [options.avatar] The new avatar as a base64 data string
    * @returns {Promise<ExtendedUser>}
    */
    editSelf(options) {
        if(!this.user) {
            return Promise.reject(new Error("Bot not ready yet"));
        }
        return this.callAPI("PATCH", Endpoints.ME, true, {
            username: options.username || this.user.username,
            avatar: options.avatar || this.user.avatar
        }).then((data) => new ExtendedUser(data));
    }

    /**
    * Get a DM channel with a user, or create one if it does not exist
    * @arg {String} userID The ID of the user
    * @returns {Promise<PrivateChannel>}
    */
    getDMChannel(userID) {
        if(this.privateChannelMap[userID]) {
            return Promise.resolve(this.privateChannels.get(this.privateChannelMap[userID]));
        }
        return this.callAPI("POST", Endpoints.ME_CHANNELS, true, {
            recipients: [userID],
            type: 1
        }).then((privateChannel) => new PrivateChannel(privateChannel, this));
    }

    /**
    * Get a previous message in a channel
    * @arg {String} channelID The ID of the channel
    * @arg {String} messageID The ID of the message
    * @returns {Promise<Message>}
    */

    getMessage(channelID, messageID) {
        return this.callAPI("GET", Endpoints.CHANNEL_MESSAGE(channelID, messageID), true).then((message) => new Message(message, this));
    }

    /**
    * Get previous messages in a channel
    * @arg {String} channelID The ID of the channel
    * @arg {Number} [limit=50] The max number of messages to get (maximum 100)
    * @arg {String} [before] Get messages before this message ID
    * @arg {String} [after] Get messages after this message ID
    * @arg {String} [around] Get messages around this message ID (does not work with limit > 100)
    * @returns {Promise<Message[]>}
    */
    getMessages(channelID, limit, before, after, around) {
        if(limit && limit > 100) {
            return new Promise((resolve, reject) => {
                var logs = [];
                var get = (_before, _after) => {
                    this.callAPI("GET", Endpoints.CHANNEL_MESSAGES(channelID), true, {
                        limit: 100,
                        before: _before,
                        after: _after
                    }).catch(reject).then((messages) => {
                        if(limit <= messages.length) {
                            return resolve(logs.concat((_after ? messages.reverse() : messages).splice(0, limit).map((message) => new Message(message, this))));
                        }
                        limit -= messages.length;
                        logs = logs.concat((_after ? messages.reverse() : messages).map((message) => new Message(message, this)));
                        if(messages.length < 100) {
                            return resolve(logs);
                        }
                        this.emit("debug", "Getting " + limit + " more messages during getMessages for " + channelID, -1);
                        get((_before || !_after) && messages[messages.length - 1].id, _after && messages[0].id);
                    });
                };
                get(before, after);
            });
        }
        return this.callAPI("GET", Endpoints.CHANNEL_MESSAGES(channelID), true, {
            limit: limit || 50,
            before,
            after,
            around
        }).then((messages) => messages.map((message) => {
            try {
                return new Message(message, this);
            } catch(err) {
                this.emit("error", "ERROR CREATING MESSAGE FROM CHANNEL MESSAGES: " + JSON.stringify(messages));
                return null;
            }
        }));
    }

    /**
    * Get all the pins in a channel
    * @arg {String} channelID The ID of the channel
    * @returns {Promise<Message[]>}
    */

    getPins(channelID) {
        return this.callAPI("GET", Endpoints.CHANNEL_PINS(channelID), true).then((messages) => messages.map((message) => new Message(message, this)));
    }

    /**
    * Create a message in a channel
    * @arg {String} channelID The ID of the channel
    * @arg {String | Object} content A string or object. If an object is passed:
    * @arg {String} content.content A content string
    * @arg {Boolean} [content.tts] Set the message TTS flag
    * @arg {Boolean} [content.disableEveryone] Whether to filter @everyone/@here or not (overrides default)
    * @arg {Object} [file] A file object
    * @arg {String} file.file A readable stream or buffer
    * @arg {String} file.name What to name the file
    * @returns {Promise<Message>}
    */
    createMessage(channelID, content, file) {
        if(!content) {
            content = "";
        }
        if(typeof content !== "object" || content.content === undefined) {
            content = {
                content: content.toString()
            };
        } else if(typeof content.content !== "string") {
            content.content = (content.content || "").toString();
        }
        if(content.content === "" && !file) {
            return Promise.reject(new Error("No content or file"));
        }
        if(content.disableEveryone !== undefined ? content.disableEveryone : this.options.disableEveryone) {
            content.content = content.content.replace(/@everyone/g, "@\u200beveryone").replace(/@here/g, "@\u200bhere");
        }
        return this.callAPI("POST", Endpoints.CHANNEL_MESSAGES(channelID), true, content, file).then((message) => new Message(message, this));
    }

    /**
    * Edit a message
    * @arg {String} channelID The ID of the channel
    * @arg {String} messageID The ID of the message
    * @arg {String} content The updated message content
    * @arg {Boolean} [disableEveryone] Whether to filter @everyone/@here or not (overrides default)
    * @returns {Promise<Message>}
    */
    editMessage(channelID, messageID, content, disableEveryone) {
        if(typeof content !== "string") {
            content = content.toString();
        }
        if(disableEveryone !== undefined ? disableEveryone : this.options.disableEveryone) {
            content = content.replace(/@everyone/g, "@\u200beveryone").replace(/@here/g, "@\u200bhere");
        }
        return this.callAPI("PATCH", Endpoints.CHANNEL_MESSAGE(channelID, messageID), true, {
            content
        }).then((message) => new Message(message, this));
    }

    /**
    * Pin a message
    * @arg {String} channelID The ID of the channel
    * @arg {String} messageID The ID of the message
    * @returns {Promise}
    */
    pinMessage(channelID, messageID) {
        return this.callAPI("PUT", Endpoints.CHANNEL_PIN(channelID, messageID), true);
    }

    /**
    * Unpin a message
    * @arg {String} channelID The ID of the channel
    * @arg {String} messageID The ID of the message
    * @returns {Promise}
    */
    unpinMessage(channelID, messageID) {
        return this.callAPI("DELETE", Endpoints.CHANNEL_PIN(channelID, messageID), true);
    }

    /**
    * Delete a message
    * @arg {String} channelID The ID of the channel
    * @arg {String} messageID The ID of the message
    * @returns {Promise}
    */
    deleteMessage(channelID, messageID) {
        return this.callAPI("DELETE", Endpoints.CHANNEL_MESSAGE(channelID, messageID), true);
    }

    /**
    * Bulk delete messages
    * @arg {String} channelID The ID of the channel
    * @arg {String[]} messageIDs Array of message IDs to delete
    * @returns {Promise}
    */
    deleteMessages(channelID, messageIDs) {
        if(messageIDs.length === 0) {
            return Promise.resolve();
        }
        if(messageIDs.length === 1) {
            return this.deleteMessage(channelID, messageIDs[0]);
        }
        if(messageIDs.length > 100) {
            return this.callAPI("POST", Endpoints.CHANNEL_BULK_DELETE(channelID), true, {
                messages: messageIDs.splice(0, 100)
            }).then(() => {
                setTimeout(() => {
                    this.deleteMessages(channelID, messageIDs);
                }, 1000);
            });
        }
        return this.callAPI("POST", Endpoints.CHANNEL_BULK_DELETE(channelID), true, {
            messages: messageIDs
        });
    }

    /**
    * Purge previous messages in a channel with an optional filter (bot accounts only)
    * @arg {String} channelID The ID of the channel
    * @arg {Number} limit The max number of messages to search through, -1 for no limit
    * @arg {function} [filter] Optional filter function that returns a boolean when passed a Message object
    * @arg {String} [before] Get messages before this message ID
    * @arg {String} [after] Get messages after this message ID
    * @returns {Promise<Number>} Resolves with the number of messages deleted
    */
    purgeChannel(channelID, limit, filter, before, after) {
        if(typeof filter === "string") {
            filter = (msg) => msg.content.includes(filter);
        }
        return new Promise((resolve, reject) => {
            var toDelete = [];
            var deleted = 0;
            var done = false;
            var checkToDelete = () => {
                var messageIDs = (done && toDelete) || (toDelete.length >= 100 && toDelete.splice(0, 100));
                if(messageIDs) {
                    deleted += messageIDs.length;
                    this.deleteMessages(channelID, messageIDs).catch(reject).then(() => {
                        if(done) {
                            return resolve(deleted);
                        }
                        setTimeout(() => {
                            checkToDelete();
                        }, 1000);
                    });
                } else if(done) {
                    return resolve(deleted);
                } else {
                    setTimeout(() => {
                        checkToDelete();
                    }, 250);
                }
            };
            var del = (_before, _after) => {
                this.getMessages(channelID, 100, _before, _after).catch(reject).then((messages) => {
                    if(limit === 0) {
                        done = true;
                        return;
                    }
                    for(var message of messages) {
                        if(limit === 0) {
                            break;
                        }
                        if(!filter || filter(message)) {
                            toDelete.push(message.id);
                        }
                        limit--;
                    }
                    if(limit === 0 || messages.length < 100) {
                        done = true;
                        return;
                    }
                    del((_before || !_after) && messages[messages.length - 1].id, _after && messages[0].id);
                });
            };
            del(before, after);
            checkToDelete();
        });
    }

    /**
    * Get a list of integrations for a guild
    * @arg {String} guildID The ID of the guild
    * @returns {Promise<GuildIntegration[]>}
    */
    getGuildIntegrations(guildID) {
        var guild = this.guilds.get(guildID);
        return this.callAPI("GET", Endpoints.GUILD_INTEGRATIONS(guildID), true).then((integrations) => integrations.map((integration) => new GuildIntegration(integration, guild)));
    }

    // adding createGuildIntegration is questionable, why are you doing this programatically

    /**
    * Edit a guild integration
    * @arg {String} guildID The ID of the guild
    * @arg {String} integrationID The ID of the integration
    * @arg {Object} options The properties to edit
    * @arg {String} [options.expireBehavior] What to do when a user's subscription runs out
    * @arg {String} [options.expireGracePeriod] How long before the integration's role is removed from an unsubscribed user
    * @arg {String} [options.enableEmoticons] Whether to enable integration emoticons or not
    * @returns {Promise}
    */
    editGuildIntegration(guildID, integrationID, options) {
        return this.callAPI("DELETE", Endpoints.GUILD_INTEGRATION(guildID, integrationID), true, {
            expire_behavior: options.expireBehavior,
            expire_grace_period: options.expireGracePeriod,
            enable_emoticons: options.enableEmoticons
        });
    }

    /**
    * Delete a guild integration
    * @arg {String} guildID The ID of the guild
    * @arg {String} integrationID The ID of the integration
    * @returns {Promise}
    */
    deleteGuildIntegration(guildID, integrationID) {
        return this.callAPI("DELETE", Endpoints.GUILD_INTEGRATION(guildID, integrationID), true);
    }

    /**
    * Force a guild integration to sync
    * @arg {String} guildID The ID of the guild
    * @arg {String} integrationID The ID of the integration
    * @returns {Promise}
    */
    syncGuildIntegration(guildID, integrationID) {
        return this.callAPI("POST", Endpoints.GUILD_INTEGRATION_SYNC(guildID, integrationID), true);
    }

    /**
    * Get all invites in a guild
    * @arg {String} guildID The ID of the guild
    * @returns {Promise<Invite[]>}
    */
    getGuildInvites(guildID) {
        return this.callAPI("GET", Endpoints.GUILD_INVITES(guildID), true).then((invites) => invites.map((invite) => new Invite(invite)));
    }

    /**
    * Ban a user from a guild
    * @arg {String} guildID The ID of the guild
    * @arg {String} userID The ID of the user
    * @arg {Number} [deleteMessageDays=0] Number of days to delete messages for
    * @returns {Promise}
    */
    banGuildMember(guildID, userID, deleteMessageDays) {
        return this.callAPI("PUT", Endpoints.GUILD_BAN(guildID, userID), true, {
            delete_message_days: deleteMessageDays || 0
        });
    }

    /**
    * Unban a user from a guild
    * @arg {String} guildID The ID of the guild
    * @arg {String} userID The ID of the user
    * @returns {Promise}
    */
    unbanGuildMember(guildID, userID) {
        return this.callAPI("DELETE", Endpoints.GUILD_BAN(guildID, userID), true);
    }

    /**
    * Create a guild
    * @arg {String} name The name of the guild
    * @arg {String} region The region of the guild
    * @arg {String} [icon] The guild icon as a base64 data string
    * @returns {Promise<Guild>}
    */
    createGuild(name, region, icon) {
        icon = icon || null;
        return this.callAPI("POST", Endpoints.GUILDS, true, {
            name,
            region,
            icon
        }).then((guild) => new Guild(guild, this));
    }

    /**
    * Edit a guild
    * @arg {String} guildID The ID of the guild
    * @arg {Object} options The properties to edit
    * @arg {String} [options.name] The ID of the guild
    * @arg {String} [options.region] The region of the guild
    * @arg {String} [options.icon] The guild icon as a base64 data string
    * @arg {Number} [options.verificationLevel] The guild verification level
    * @arg {String} [options.afkChannelID] The ID of the AFK voice channel
    * @arg {Number} [options.afkTimeout] The AFK timeout in seconds
    * @arg {String} [options.ownerID] The ID of the user to transfer server ownership to (bot user must be owner)
    * @arg {String} [options.splash] The guild splash image as a base64 data string (VIP only)
    * @returns {Promise<Guild>}
    */
    editGuild(guildID, options) {
        var guild = this.guilds.get(guildID);
        if(!guild) {
            return Promise.reject(new Error(`Guild ${guildID} not found`));
        }

        return this.callAPI("PATCH", Endpoints.GUILD(guildID), true, {
            name: options.name || guild.name,
            region: options.region,
            icon: options.icon,
            verification_level: options.verificationLevel,
            afk_channel_id: options.afkChannelID,
            afk_timeout: options.afkTimeout,
            splash: options.splash,
            owner_id: options.ownerID
        }).then((guild) => new Guild(guild, this));
    }

    /**
    * Get the ban list of a guild
    * @arg {String} guildID The ID of the guild
    * @returns {Promise<User[]>}
    */
    getGuildBans(guildID) {
        return this.callAPI("GET", Endpoints.GUILD_BANS(guildID), true).then((bans) => bans.map((ban) => new User(ban.user)));
    }

    /**
    * Edit a guild member
    * @arg {String} guildID The ID of the guild
    * @arg {String} userID The ID of the user
    * @arg {Object} options The properties to edit
    * @arg {String[]} [options.roles] The array of role IDs the user should have
    * @arg {String} [options.nick] Set the user's server nickname, "" to remove
    * @arg {Boolean} [options.mute] Server mute the user
    * @arg {Boolean} [options.deaf] Server deafen the user
    * @arg {String} [options.channelID] The ID of the voice channel to move the user to (must be in voice)
    * @returns {Promise}
    */
    editGuildMember(guildID, userID, options) {
        return this.callAPI("PATCH", Endpoints.GUILD_MEMBER(guildID, userID), true, {
            roles: options.roles,
            nick: options.nick,
            mute: options.mute,
            deaf: options.deaf,
            channel_id: options.channelID
        });
    }

    /**
    * Edit the bot's nickname in a guild
    * @arg {String} guildID The ID of the guild
    * @arg {String} nick The nickname
    * @returns {Promise}
    */
    editNickname(guildID, nick) {
        return this.callAPI("PATCH", Endpoints.GUILD_ME_NICK(guildID), true, {
            nick
        });
    }

    /**
    * Remove (kick) a member from a guild
    * @arg {String} guildID The ID of the guild
    * @arg {String} userID The ID of the user
    * @returns {Promise}
    */
    deleteGuildMember(guildID, userID) {
        return this.callAPI("DELETE", Endpoints.GUILD_MEMBER(guildID, userID), true);
    }

    /**
    * Delete a guild (bot account must be user)
    * @arg {String} guildID The ID of the guild
    * @returns {Promise}
    */
    deleteGuild(guildID) {
        return this.callAPI("DELETE", Endpoints.GUILD(guildID), true);
    }

    /**
    * Leave a guild
    * @arg {String} guildID The ID of the guild
    * @returns {Promise}
    */
    leaveGuild(guildID) {
        return this.callAPI("DELETE", Endpoints.ME_GUILD(guildID), true);
    }

    /**
    * Get data on an OAuth2 application
    * @arg {String} [appID="@me"] The client ID of the application to get data for. "@me" refers to the logged in user's own application
    * @returns {Promise<Object>} The bot's application data. Refer to <a href="https://discordapp.com/developers/docs/topics/oauth2#get-current-application-information">the official Discord API documentation entry</a> for Object structure
    */
    getOAuthApplication(appID) {
        return this.callAPI("GET", Endpoints.OAUTH2_APPLICATION(appID || "@me"), true);
    }

    bucketsFromRequest(method, url, body) {
        var match = url.match(/^\/channels\/([0-9]+)\/messages(\/[0-9]+)?$/);
        if(match) {
            if(method === "DELETE" && this.getChannel(match[1])) {
                return ["dmsg:" + this.channelGuildMap[match[1]]];
            } else if(this.user.bot) {
                if(method === "POST" || method === "PATCH") {
                    if(this.privateChannels.get(match[1])) {
                        return ["bot:msg:dm", "bot:msg:global"];
                    } else if(this.channelGuildMap[match[1]]) {
                        return ["bot:msg:guild:" + this.channelGuildMap[match[1]], "bot:msg:global"];
                    }
                }
            } else {
                return ["msg"];
            }
        } else if(method === "PATCH") {
            if(url === "/users/@me" && this.user && body.username !== this.user.username) {
                return ["username"];
            } else if((match = url.match(/^\/guilds\/([0-9]+)\/members\/[0-9]+$/))) {
                return ["guild_member:" + match[1]];
            } else if((match = url.match(/^\/guilds\/([0-9]+)\/members\/@me\/nick$/))) {
                return ["guild_member_nick:" + match[1]];
            }
        }
        return [];
    }

    /**
    * Make an API request
    * @arg {String} method Lowercase HTTP method
    * @arg {String} url URL of the endpoint
    * @arg {Boolean} auth Whether to add the Authorization header and token or not
    * @arg {Object} [body] Request payload
    * @arg {Object} [file] File object
    * @arg {String} file.file A readable stream or buffer
    * @arg {String} file.name What to name the file
    * @returns {Promise<Object>} Resolves with the returned JSON data
    */
    callAPI(method, url, auth, body, file) {
        var resolve, reject;
        var promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        var buckets = this.bucketsFromRequest(method, url, body);
        var attempts = 1;
        var actualCall = () => {
            var headers = {
                "User-Agent": this.userAgent
            };
            var data;
            if(auth) {
                headers.Authorization = this.token;
            }
            if(file && file.file) {
                data = new MultipartData();
                headers["Content-Type"] = "multipart/form-data; boundary=" + data.boundary;
                data.attach("file", file.file, file.name);
                if(body) {
                    for(var i in body) {
                        if(body[i] !== undefined) {
                            data.attach(i, body[i]);
                        }
                    }
                }
                data = data.finish();
            } else if(body) {
                if(method === "GET" || (method === "PUT" && url.includes("/bans/"))) { // TODO remove PUT case when devs fix
                    url += "?"
                    var qs = [];
                    for(var i in body) {
                        if(body[i] !== undefined) {
                            qs.push(encodeURIComponent(i) + "=" + encodeURIComponent(body[i]));
                        }
                    }
                    url += qs.join("&");
                } else {
                    data = JSON.stringify(body);
                    headers["Content-Type"] = "application/json";
                }
            }
            var req = HTTPS.request({
                method: method,
                host: "discordapp.com",
                path: Endpoints.BASE_URL + url,
                headers: headers
            });

            req.on("error", (err) => {
                req.abort();
                reject(err);
            });

            req.on("response", (resp) => {
                var response = [];

                resp.on("data", (chunk) => {
                    response.push(chunk);
                });

                resp.once("end", () => {
                    response = Buffer.concat(response).toString("utf8");
                    if(resp.statusCode >= 300) {
                        if(resp.statusCode === 429) {
                            if(this.options.buckets) {
                                this.emit("warn", "UNEXPECTED BUCKET 429 (╯°□°）╯︵ ┻━┻ " + response);
                            } else {
                                if(buckets.length < 1) {
                                    this.emit("warn", "UNEXPECTED 429 (╯°□°）╯︵ ┻━┻ " + response);
                                }
                                try {
                                    response = JSON.parse(response);
                                } catch(err) {
                                    req.abort();
                                    return reject("Invalid JSON: " + response);
                                }
                                setTimeout(actualCall, this.buckets[buckets[0]] = response.retry_after);
                                this.buckets[buckets[0]] += Date.now();
                                return;
                            }
                        } else if(resp.statusCode === 502 && ++attempts < 4) {
                            setTimeout(actualCall, Math.floor(Math.random() * 900 + 100));
                            return;
                        }
                        var err = new Error(`${resp.statusCode} ${resp.statusMessage}`);
                        err.resp = resp;
                        err.response = response;
                        err.req = req;
                        req.abort();
                        return reject(err);
                    }
                    if(response.length > 0) {
                        if(resp.headers["content-type"] === "application/json") {
                            try {
                                response = JSON.parse(response);
                            } catch(err) {
                                req.abort();
                                return reject("Invalid JSON: " + response);
                            }
                        }
                    }
                    resolve(response);
                });
            });

            req.end(data);
        };
        if(this.options.buckets) {
            var waitFor = 1;
            var i = 0;
            var done = () => {
                if(++i === waitFor) {
                    actualCall();
                }
            };
            for(let bucket of buckets) {
                ++waitFor;
                this.buckets[bucket].queue(done);
            }
            done();
        } else {
            if(this.buckets[buckets[0]]) {
                if(this.buckets[buckets[0]] <= Date.now) {
                    this.buckets[buckets[0]] = null;
                } else {
                    setTimeout(actualCall, this.buckets[buckets[0]]);
                }
            } else {
                actualCall();
            }
        }
        return promise;
    }
}

module.exports = Client;
