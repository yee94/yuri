export const yuriGuiNetworkContract = {
  pluginName: 'YuriGuiNetwork',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriGuiNetworkPlugin.swift'],
    android: ['packages/mobile/android/app/src/main/java/com/yuri/app/YuriGuiNetworkPlugin.java'],
  },
  methods: { ios: ['prepare', 'capabilities', 'start', 'send', 'stop', 'connect', 'write', 'disconnect'], android: ['prepare', 'capabilities', 'start', 'send', 'stop', 'connect', 'write', 'disconnect'] },
  events: { ios: ['stream', 'wire'], android: ['stream', 'wire'] },
};
