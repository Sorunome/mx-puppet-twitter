import {
	PuppetBridge,
	IPuppetBridgeFeatures,
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

const features = {
	image: true,
	file: true,
} as IPuppetBridgeFeatures;

const puppet = new PuppetBridge(options["registration-file"], options.config, features);

if (options.register) {
	// okay, all we have to do is generate a registration file
	puppet.readConfig();
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
	const twitter = new Twitter(puppet);
	puppet.on("puppetNew", twitter.newPuppet.bind(twitter));
	puppet.on("puppetDelete", twitter.deletePuppet.bind(twitter));
	
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
