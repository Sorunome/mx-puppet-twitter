import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChan,
	IRemoteUser,
	IMessageEvent,
	IFileEvent,
	Util,
	IRetList,
} from "mx-puppet-bridge";
import * as Twit from "twit";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as twitterWebhooks from "twitter-webhooks";
import * as http from "http";
import { Config } from "./index";
import { getOAuthFile } from "./oauth";

const log = new Log("TwitterPuppet:Twitter");

const app = express();

interface ITwitterPuppet {
	client: Twit,
	data: any,
	sentEventIds: string[],
	typingUsers: {[key: string]: any},
}

interface ITwitterPuppets {
	[puppetId: number]: ITwitterPuppet;
}

export class Twitter {
	private puppets: ITwitterPuppets = {};
	private webhook: any = null;
	constructor(
		private puppet: PuppetBridge,
	) {
		app.use(bodyParser.json());
		app.listen(Config().twitter.server.port, Config().twitter.server.host);
	}

	public getSendParams(puppetId: number, msg: any, msgCont: any) {
		const p = this.puppets[puppetId];
		let roomId = msgCont.sender_id;
		if (roomId === p.data.id) {
			roomId = msgCont.target.recipient_id;
		}
		return {
			chan: {
				puppetId,
				roomId,
				isDirect: true,
			},
			user: {
				puppetId,
				userId: msgCont.sender_id,
			},
			eventId: msg.id,
		} as IReceiveParams;
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new Twit({
			consumer_key: Config().twitter.consumerKey,
			consumer_secret: Config().twitter.consumerSecret,
			access_token: data.accessToken,
			access_token_secret: data.accessTokenSecret,
		});
		this.puppets[puppetId] = {
			client,
			data,
			sentEventIds: [],
			typingUsers: {},
		} as ITwitterPuppet;
		const p = this.puppets[puppetId];
		client.getAsync = (...args) => {
			return new Promise((resolve, reject) => {
				client.get(...args, (err, data) => {
					err ? reject(err) : resolve(data);
				});
			});
		};
		client.postAsync = (...args) => {
			return new Promise((resolve, reject) => {
				client.post(...args, (err, data) => {
					err ? reject(err) : resolve(data);
				});
			});
		};
		try {
			const auth = await client.getAsync("account/verify_credentials");
			data.screenName = auth.screen_name;
			data.id = auth.id_str;
			data.name = auth.name;
			await this.puppet.setUserId(puppetId, data.id);
			await this.puppet.setPuppetData(puppetId, data);

			let userActivity;
			const userActivityOptions = {
				userId: data.id,
				accessToken: data.accessToken,
				accessTokenSecret: data.accessTokenSecret,
			};
			try {
				userActivity = await this.webhook.subscribe(userActivityOptions);
			} catch (err) {
				// if it is already subscribed we just need to re-subscribe to get the real object
				log.warning("Failed to subscribe to user, retrying...", err);
				await this.webhook.unsubscribe(userActivityOptions);
				userActivity = await this.webhook.subscribe(userActivityOptions);
			}
			userActivity.on("direct_message", async (dm) => {
				if (p.sentEventIds.includes(dm.id)) {
					// we sent this element, please dedupe
					log.silly("Dropping message due to dedupe");
					const ix = p.sentEventIds.indexOf(dm.id);
					p.sentEventIds.splice(ix, 1);
					return;
				}
				switch (dm.type) {
					case "message_create": {
						await this.handleTwitterMessage(puppetId, dm);
						break;
					}
					default: {
						log.silly("Unknown message type");
						log.silly(dm);
					}
				}
			});
			userActivity.on("direct_message_indicate_typing", async (typing) => {
				await this.handleTwitterTyping(puppetId, typing);
			});
			await this.puppet.sendStatusMessage(puppetId, "connected!");
		} catch (err) {
			log.error(`Failed to start up puppet ${puppetId}`, err);
			await this.puppet.sendStatusMessage(puppetId, `**disconnected!**: failed to connect. ${err}`);
		}
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		const p = this.puppets[puppetId];
		if (!p) {
			return; // nothing to do
		}
		await this.webhook.unsubscribe({
			userId: p.data.id,
			accessToken: p.data.accessToken,
			accessTokenSecret: p.data.accessTokenSecret,
		});
		delete this.puppet[puppetId];
	}

	public async handleTwitterTyping(puppetId: number, typing: any) {
		const p = this.puppets[puppetId];
		const params = this.getSendParams(puppetId, typing, typing);
		const typingKey = `${params.user.userId};${params.chan.roomId}`;
		p.typingUsers[typingKey] = params;
		await this.puppet.setUserTyping(params, true);
	}

	public async handleTwitterMessage(puppetId: number, dm: any) {
		const p = this.puppets[puppetId];
		log.verbose("Got message from twitter to pass on");
		const messageData = dm.message_create.message_data;
		const params = this.getSendParams(puppetId, dm, dm.message_create);
		const typingKey = `${params.user.userId};${params.chan.roomId}`;
		if (p.typingUsers[typingKey]) {
			// user is typing, stop that
			await this.puppet.setUserTyping(p.typingUsers[typingKey], false);
			delete p.typingUsers[typingKey];
		}
		let noMsg = "";
		if (messageData.attachment) {
			log.silly(messageData);
			switch (messageData.attachment.type) {
				case "media": {
					const media = messageData.attachment.media;
					noMsg = ` ${media.url}`;
					const url = media.media_url_https;
					const buffer = await getOAuthFile(url, {
						access_token: p.data.accessToken,
						access_token_secret: p.data.accessTokenSecret,
					});
					await this.puppet.sendFileDetect(params, buffer);
					break;
				}
				default: {
					log.silly("unknown attachment type", messageData);
				}
			}
		}
		const text = dm.message_create.message_data.text;
		if (!(noMsg && text === noMsg)) {
			await this.puppet.sendMessage(params, {
				body: text,
			});
		}
	}

	public async sendMessageToTwitter(p: ITwitterPuppet, room: IRemoteChan, eventId: string, msg: string, mediaId?: string) {
		const event = {
			type: "message_create",
			message_create: {
				target: {
					recipient_id: room.roomId,
				},
				message_data: {
					text: msg,
				},
			},
		} as any;
		if (mediaId) {
			event.message_create.message_data.attachment = {
				type: "media",
				media: {
					id: mediaId,
				},
			};
		}
		const reply = await p.client.postAsync("direct_messages/events/new", {
			event,
		});
		if (reply && reply.event && reply.event.id) {
			await this.puppet.eventStore.insert(room.puppetId, eventId, reply.event.id);
			p.sentEventIds.push(reply.event.id);
		}
	}

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got message to send on");
		// room.roomId, data.body
		await this.sendMessageToTwitter(p, room, data.eventId!, data.body);
	}

	public async uploadFileToTwitter(p: ITwitterPuppet, data: IFileEvent, category: string): Promise<string> {
		log.silly("Downloading image....");
		const buffer = await Util.DownloadFile(data.url);
		let fileSize = buffer.byteLength
		const mediaUpload = await p.client.postAsync("media/upload", {
			command: "INIT",
			total_bytes: fileSize,
			media_type: data.info!.mimetype,
			media_category: category,
		});
		log.silly(mediaUpload);
		log.silly(fileSize);
		const mediaId = mediaUpload.media_id_string;
		let segmentIndex = 0;
		let sizeSent = 0;
		while (sizeSent < fileSize) {
			const FIVE_MB = 5*1024*1024;
			let bufferSend = Buffer.alloc(FIVE_MB);
			buffer.copy(bufferSend, 0, sizeSent, sizeSent + FIVE_MB);
			if (sizeSent + FIVE_MB > fileSize) {
				bufferSend = bufferSend.slice(0, fileSize - sizeSent);
			}
			await p.client.postAsync("media/upload", {
				command: "APPEND",
				media_id: mediaId,
				media: bufferSend.toString("base64"),
				segment_index: segmentIndex,
			});
			segmentIndex++;
			sizeSent += FIVE_MB;
		}
		log.silly("done uploading");
		await p.client.postAsync("media/upload", {
			command: "FINALIZE",
			media_id: mediaId,
		});
		log.silly("done finalizing");
		return mediaId;
	}

	public async handleMatrixImage(room: IRemoteChan, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got image to send on");
		try {
			const mediaId = await this.uploadFileToTwitter(p, data, data.info!.mimetype!.includes("gif") ? "dm_gif" : "dm_image");
			log.silly(mediaId);
			await this.sendMessageToTwitter(p, room, data.eventId!, "", mediaId);
		} catch (err) {
			log.error("Error sending image", err);
			log.error(err.twitterReply);
			await this.sendMessageToTwitter(p, room, data.eventId!, `Sent a new image: ${data.url}`);
		}
	}

	public async handleMatrixVideo(room: IRemoteChan, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got video to send on");
		try {
			const mediaId = await this.uploadFileToTwitter(p, data, "dm_video");
			log.silly(mediaId);
			await this.sendMessageToTwitter(p, room, data.eventId!, "", mediaId);
		} catch (err) {
			log.error("Error sending image", err);
			await this.sendMessageToTwitter(p, room, data.eventId!, `Sent a new video: ${data.url}`);
		}
	}

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		log.verbose(`Got request to create user ${user.userId}`);
		try {
			const twitterUser = await p.client.getAsync("users/show", { user_id: user.userId });
			return {
				userId: user.userId,
				puppetId: user.puppetId,
				name: twitterUser.name,
				avatarUrl: twitterUser.profile_image_url_https,
			};
		} catch (err) {
			log.error("Failed to get user");
			log.error(err);
			return null;
		}
	}

	public async addWebhook() {
		if (this.webhook) {
			return;
		}
		this.webhook = twitterWebhooks.userActivity({
			serverUrl: Config().twitter.server.url,
			route: "/webhook",
			consumerKey: Config().twitter.consumerKey,
			consumerSecret: Config().twitter.consumerSecret,
			accessToken: Config().twitter.accessToken,
			accessTokenSecret: Config().twitter.accessTokenSecret,
			environment: Config().twitter.environment,
			app,
		});
		
		const oldWebhooks = await this.webhook.getWebhooks();
		for (const env of oldWebhooks.environments) {
			for (const hook of env.webhooks) {
				const id = hook.id;
				try {
					await this.webhook.unregister({
						webhookId: id,
					});
				} catch (err) {
					log.error("Failed to un-register old webhook", err);
				}
			}
		}
		try {
			await this.webhook.register();
		} catch (err) {
			log.error("Failed to register new webhook", err);
		}
	}
}
