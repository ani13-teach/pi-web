import packageInfo from "../../package.json" with { type: "json" };
/** Pinned project SDK, not the unrelated globally installed Pi CLI. */
export const BACKUP_SDK_VERSION = packageInfo.dependencies["@earendil-works/pi-coding-agent"];
