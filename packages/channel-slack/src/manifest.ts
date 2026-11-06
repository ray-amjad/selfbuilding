/**
 * The Slack app manifest for the Slack channel. Paste the JSON into "Create an app → From a manifest",
 * install the app, and copy the bot token and signing secret into your secret store. `requestUrl` is where
 * `createHitlHandler()` from `@selfbuilding/hooks` is mounted; Slack sends interactions and events there.
 * `slack-app-manifest.json` next to this package is the same manifest with a placeholder URL.
 */
export function slackAppManifest(opts: { requestUrl: string; name?: string }): Record<string, unknown> {
  const name = opts.name ?? "Selfbuilding";
  return {
    display_information: {
      name,
      description: "Questions, approvals and run summaries from your Selfbuilding factory.",
    },
    features: {
      bot_user: { display_name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: ["chat:write", "channels:history", "groups:history", "channels:read", "groups:read", "users:read"],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: opts.requestUrl,
        bot_events: ["message.channels", "message.groups"],
      },
      interactivity: { is_enabled: true, request_url: opts.requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
