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
	constructor(
		private puppet: PuppetBridge,
	) {
		app.use(bodyParser.json());
		app.listen(Config().twitter.server.port, Config().twitter.server.host);
	}

	public getSendParams(puppetId: number, msg: any, msgCont: any) {
		return {
			chan: {
				puppetId,
				roomId: msgCont.sender_id,
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
			access_token: Config().twitter.accessToken,
			access_token_secret: Config().twitter.accessTokenSecret,
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
			switch (dm.type) {
				case "message_create": {
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
