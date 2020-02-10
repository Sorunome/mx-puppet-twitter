[![Support room on Matrix](https://img.shields.io/matrix/mx-puppet-discord:sorunome.de.svg?label=%23mx-puppet-discord%3Asorunome.de&logo=matrix&server_fqdn=sorunome.de)](https://matrix.to/#/#mx-puppet-discord:sorunome.de) [![donate](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/Sorunome/donate)

# mx-puppet-twitter
This is a twitter puppeting bridge for matrix. It is based on [mx-puppet-bridge](https://github.com/Sorunome/mx-puppet-bridge).

# Setup

## Twitter API access

You will need to create a Twitter developer account and a Twitter app, which can be done here: https://developer.twitter.com/en/apps

**NOTE:** This service uses Twitter's webhooks API. For it to work, you will need the ability to configure a publically accessible URL serving SSL on port 443. Twitter webhooks will not work with any other port. You will likely want to set up a reverse proxy such as Nginx to handle SSL. If you're hosting this on your home network, your ISP may be blocking port 443, in which case you will need to either host it somewhere else, or set up a reverse proxy with port 443 on a VPS back to an open port. This setup and others are beyond the scope of this README.

## Configuration

Copy the `sample.config.yaml` to `config.yaml` and edit it appropriately. The sample config includes some sensible defaults and comments describing each option.

Run `node ./src/index.js`. This will generate a `twitter-registration.yaml` file. Edit that file as needed. In particular, the `url` option needs to be set to a URL where the bridge can communicate with your homeserver. Copy this file to your Synapse homeserver.

Run `node ./src/index.js` again to start the bridge. (If you encounter errors here, it is likely because Twitter is unable to reach the webhooks server, or because the bridge is unable to reach your homeserver.)

On your Synapse homeserver, edit your `homeserver.yaml`'s `app_service_config_files` to include the path to the `twitter-registration.yaml`, then restart your Synapse server.

## Using Docker

To run the bridge as a Docker container, create a directory for your configuration, `cd` into it, then create your `config.yaml` as described above.

Run ``docker run -v `pwd`:/data:z sorunome/mx-puppet-twitter``. This will generate the `twitter-registration.yaml`. Edit it and copy it as above, including updating your `homeserver.yaml` file and restarting Synapse.

From the same directory, run the following command, being sure to update the port mappings per your `config.yaml`:

```
docker run -d --name=mx-puppet-twitter \
  --restart unless-stopped \
  -p 6000:6000 \
  -p 6001:6001 \
  -v `pwd`:/data:z \
  sorunome/mx-puppet-twitter
```

## Usage

Start a chat with `@_twitterpuppet_bot:matrix.myhomeserver.com` and send `help` for a list of commands.
