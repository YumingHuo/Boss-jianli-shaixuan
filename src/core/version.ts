import { version } from '../../package.json';
// 在构建时写入，避免磁盘已更新但旧后台仍在运行时误报版本。
export const BUILD_VERSION = version;
