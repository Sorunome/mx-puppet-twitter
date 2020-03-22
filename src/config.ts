export class TwitterConfigWrap {
	public twitter: TwitterConfig = new TwitterConfig();

	public applyConfig(newConfig: {[key: string]: any}, configLayer: {[key: string]: any} = this) {
		Object.keys(newConfig).forEach((key) => {
			if (configLayer[key] instanceof Object && !(configLayer[key] instanceof Array)) {
				this.applyConfig(newConfig[key], configLayer[key]);
			} else {
				configLayer[key] = newConfig[key];
			}
		});
	}
}

class TwitterConfig {
	public consumerKey = "";
	public consumerSecret = "";
	public accessToken = "";
	public accessTokenSecret = "";
	public environment = "";
	public server: TwitterServerConfig = new TwitterServerConfig();
}

class TwitterServerConfig {
	public url: string = "";
	public path: string = "/webhook";
}
