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
		log.silly(auth);
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
					log.silly(dm);
					const params = this.getSendParams(puppetId, dm, dm.message_create);
					const text = dm.message_create.message_data.text;
					await this.puppet.sendMessage(params, {
						body: text,
					});
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
		const p = this.puppet[puppetId];
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

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got message to send on");
		// room.roomId, data.body
		const reply = await p.client.postAsync("direct_messages/events/new", {
			event: {
				type: "message_create",
				message_create: {
					target: {
						recipient_id: room.roomId,
					},
					message_data: {
						text: data.body,
					},
				},
			},
		});
		if (reply && reply.event && reply.event.id) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, reply.event.id);
			this.sentEventIds.push(reply.event.id);
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
		
		try {
			await this.webhook.register();
		} catch (err) {
			log.error(err);
		}
	}
}
