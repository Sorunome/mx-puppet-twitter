import { Response } from "express";
import { PuppetBridge, IAuthedRequest } from "mx-puppet-bridge";
import { getOAuthToken, getOAuthUrl } from "./oauth";

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;

export class TwitterProvisioningAPI {
	constructor(
		private puppet: PuppetBridge,
	) {
		const api = puppet.provisioningAPI;
		api.v1.post("/oauth/request", this.requestOAuthToken.bind(this));
		api.v1.post("/oauth/link", this.linkOAuthToken.bind(this));
	}

	private async requestOAuthToken(req: IAuthedRequest, res: Response) {
		res.status(OK).json(await getOAuthUrl(req.body.oauth_callback));
	}

	private async linkOAuthToken(req: IAuthedRequest, res: Response) {
		let data: any;
		try {
			data = await getOAuthToken(req.body.oauth_verifier, {
				oauth_token: req.body.oauth_token,
				oauth_secret: req.body.oauth_secret,
			});
		} catch (err) {
			res.status(FORBIDDEN).json({
				errcode: "M_UNKNOWN",
				error: err.toString(),
			});
			return;
		}
		const puppetId = await this.puppet.provisioner.new(req.userId, {
			accessToken: data.access_token,
			accessTokenSecret: data.access_token_secret,
		});
		res.status(CREATED).json({ puppet_id: puppetId });
	}
}
