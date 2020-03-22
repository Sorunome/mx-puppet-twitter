import {
	PuppetBridge,
	IProtocolInformation,
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import * as escapeHtml from "escape-html";
import { Twitter } from "./twitter";
import { TwitterConfigWrap } from "./config";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { getOAuthUrl, initOAuth, getOAuthToken } from "./oauth";

const log = new Log("TwitterPuppet:index");

const commandOptions = [
	{ name: "register", alias: "r", type: Boolean },
	{ name: "registration-file", alias: "f", type: String },
	{ name: "config", alias: "c", type: String },
	{ name: "help", alias: "h", type: Boolean },
];
const options = Object.assign({
	"register": false,
	"registration-file": "twitter-registration.yaml",
	"config": "config.yaml",
	"help": false,
}, commandLineArgs(commandOptions));

if (options.help) {
	// tslint:disable-next-line:no-console
	console.log(commandLineUsage([
		{
			header: "Matrix Twitter Puppet Bridge",
			content: "A matrix puppet bridge for twitter",
		},
		{
			header: "Options",
			optionList: commandOptions,
		},
	]));
	process.exit(0);
}

const protocol = {
	features: {
		image: true,
		video: true,
	},
	id: "twitter",
	displayname: "Twitter",
	externalUrl: "https://twitter.com/",
} as IProtocolInformation;

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

if (options.register) {
	// okay, all we have to do is generate a registration file
	puppet.readConfig(false);
	try {
		puppet.generateRegistration({
			prefix: "_twitterpuppet_",
			id: "twitter-puppet",
			url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
		} as IPuppetBridgeRegOpts);
	} catch (err) {
		// tslint:disable-next-line:no-console
		console.log("Couldn't generate registration file:", err);
	}
	process.exit(0);
}

let config: TwitterConfigWrap = new TwitterConfigWrap();

function readConfig() {
	config = new TwitterConfigWrap();
	config.applyConfig(yaml.safeLoad(fs.readFileSync(options.config)));
}

export function Config(): TwitterConfigWrap {
	return config;
}

async function run() {
	await puppet.init();
	readConfig();
	initOAuth();
	const twitter = new Twitter(puppet);
	await twitter.addWebhook();
	puppet.on("puppetNew", twitter.newPuppet.bind(twitter));
	puppet.on("puppetDelete", twitter.deletePuppet.bind(twitter));
	puppet.on("message", twitter.handleMatrixMessage.bind(twitter));
	puppet.on("image", twitter.handleMatrixImage.bind(twitter));
	puppet.on("video", twitter.handleMatrixVideo.bind(twitter));
	puppet.setCreateUserHook(twitter.createUser.bind(twitter));
	puppet.setGetDescHook(async (puppetId: number, data: any): Promise<string> => {
		let s = "Twitter";
		if (data.screenName) {
			s += ` as ${data.screenName}`;
		}
		if (data.name) {
			s += ` (${data.name})`;
		}
		return s;
	});
	puppet.setGetDataFromStrHook(async (str: string): Promise<IRetData> => {
		const auth = await getOAuthUrl();
		return {
			success: false,
			error: `Please sign in via the following URL ${auth.url} and then send in here the pin displayed.`,
			fn: async (pin: string): Promise<IRetData> => {
				const retData = {
					success: false,
				} as IRetData;
				try {
					const token = await getOAuthToken(pin, auth);
					retData.success = true;
					retData.data = {
						accessToken: token.access_token,
						accessTokenSecret: token.access_token_secret,
					};
					return retData;
				} catch (err) {
					retData.success = false;
					retData.error = `Failed to fetch tokens: ${err.data}`;
					return retData;
				}
				return retData;
			},
		};
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
