#!/bin/sh -e

chown -R bridge:bridge /data

if [ ! -f '/data/config.yaml' ]; then
	echo 'No config found'
	exit 1
fi

if [ ! -f '/data/twitter-registration.yaml' ]; then
    su -l bridge -c "/usr/local/bin/node '/opt/mx-puppet-twitter/build/index.js' \
            -c '/data/config.yaml' \
            -f '/data/twitter-registration.yaml' \
            -r"

	echo 'Registration generated.'
	exit 0
fi

su -l bridge -c "/usr/local/bin/node '/opt/mx-puppet-twitter/build/index.js' \
    -c '/data/config.yaml' \
    -f '/data/twitter-registration.yaml'"
