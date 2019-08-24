#!/bin/sh
if [ ! -f "/data/config.yaml" ]; then
	echo "No config found"
	exit 1
fi
if [ ! -f "/data/twitter-registration.yaml" ]; then
	node /opt/mx-puppet-twitter/build/index.js -c /data/config.yaml -f /data/twitter-registration.yaml -r
	echo "Registration generated."
	exit 0
fi
node /opt/mx-puppet-twitter/build/index.js -c /data/config.yaml -f /data/twitter-registration.yaml
