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
import { getOAuthPage } from "./oauth";

const log = new Log("TwitterPuppet:Twitter");

const app = express();

interface ITwitterPuppet {
	client: Twit,
	data: any,
}

interface ITwitterPuppets {
	[puppetId: number]: ITwitterPuppet;
}

export class Twitter {
	private puppets: ITwitterPuppets = {};
	private webhook: any = null;
	private sentEventIds: string[] = [];
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
		/*
		try {
			const img = await getOAuthPage("https://ton.twitter.com/i/ton/data/dm/1166760156362940422/1166760141968031746/_3FjBvCO.jpg", {
				access_token: data.accessToken,
				access_token_secret: data.accessTokenSecret,
			});
			log.silly(img);
		} catch (err) {
			log.error("Error getting image", err);
		}
		return;
		*/
		await this.addWebhook();
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
		} as ITwitterPuppet;
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

		const auth = await client.getAsync("account/verify_credentials");
		data.screenName = auth.screen_name;
		data.id = auth.id_str;
		data.name = auth.name;
		await this.puppet.setUserId(puppetId, data.id);
		await this.puppet.setPuppetData(puppetId, data);

		let userActivity;
		try {
			userActivity = await this.webhook.subscribe({
				userId: data.id,
				accessToken: data.accessToken,
				accessTokenSecret: data.accessTokenSecret,
			});
		} catch (err) {
			// if it is already subscribed we just need to re-subscribe to get the real object
			await this.webhook.unsubscribe({
				userId: data.id,
				accessToken: data.accessToken,
				accessTokenSecret: data.accessTokenSecret,
			});
			userActivity = await this.webhook.subscribe({
				userId: data.id,
				accessToken: data.accessToken,
				accessTokenSecret: data.accessTokenSecret,
			});
		}
		userActivity.on("direct_message", async (dm) => {
			if (this.sentEventIds.includes(dm.id)) {
				// we sent this element, please dedupe
				const ix = this.sentEventIds.indexOf(dm.id);
				this.sentEventIds.splice(ix, 1);
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
		await this.puppet.sendStatusMessage(puppetId, "connected!");
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

	public async handleTwitterMessage(puppetId: number, dm: any) {
		const p = this.puppets[puppetId];
		const messageData = dm.message_create.message_data;
		const params = this.getSendParams(puppetId, dm, dm.message_create);
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
		if (noMsg && text !== noMsg) {
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
			this.sentEventIds.push(reply.event.id);
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

	private async addWebhook() {
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
