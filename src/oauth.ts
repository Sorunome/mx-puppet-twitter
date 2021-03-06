import { Log, Util } from "mx-puppet-bridge";
import { OAuth } from "oauth";
import { Config } from "./index";

const log = new Log("TwitterPuppet:oauth");

// oauth stuffs in part from https://github.com/Half-Shot/matrix-appservice-twitter/blob/master/src/AccountServices.js

// tslint:disable variable-name

export interface IOAuthData {
	oauth_token: string;
	oauth_secret: string;
	url: string;
}

export interface IOAuthToken {
	access_token: string;
	access_token_secret: string;
}

let oauth;
export function initOAuth() {
	oauth = new OAuth(
		"https://api.twitter.com/oauth/request_token",
		"https://api.twitter.com/oauth/access_token",
		Config().twitter.consumerKey,
		Config().twitter.consumerSecret,
		"1.0A",
		null,
		"HMAC-SHA1",
	);
}

export async function getOAuthUrl(callback: string = "oob"): Promise<IOAuthData> {
	return new Promise((resolve, reject) => {
		oauth.getOAuthRequestToken(
			{x_auth_access_type: "dm", oauth_callback: callback},
			(error, oAuthToken, oAuthTokenSecret, dat) => {
				if (error) {
					return reject(error);
				}
				const authURL = "https://twitter.com/oauth/authorize?oauth_token=" + oAuthToken;
				const data = {
					oauth_token: oAuthToken,
					oauth_secret: oAuthTokenSecret,
					url: authURL,
				};
				resolve(data);
			},
		);
	});
}

export async function getOAuthToken(pin: string, data: any): Promise<IOAuthToken> {
	return new Promise((resolve, reject) => {
		oauth.getOAuthAccessToken(data.oauth_token, data.oauth_secret, pin,
			(error, access_token, access_token_secret) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({
				access_token,
				access_token_secret,
			});
		});
	});
}

export async function getOAuthFile(url: string, token: IOAuthToken): Promise<any> {
	const orderedParameters = oauth._prepareParameters(token.access_token, token.access_token_secret, "GET", url, null);
	const headers = {} as {[name: string]: string};
	headers.Authorization = oauth._buildAuthorizationHeaders(orderedParameters);
	return await Util.DownloadFile(url, {
		headers,
		responseType: "buffer",
	});
}
