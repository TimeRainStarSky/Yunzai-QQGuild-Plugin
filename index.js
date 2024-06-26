logger.info(logger.yellow("- 正在加载 QQ频道 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import { FormData, Blob } from "node-fetch"
import QRCode from "qrcode"
import urlRegexSafe from "url-regex-safe"
import { createOpenAPI, createWebsocket } from "qq-guild-bot"

const { config, configSave } = await makeConfig("QQGuild", {
  tips: "",
  permission: "master",
  recallHide: false,
  toQRCode: true,
  bot: { maxRetry: Infinity },
  token: [],
}, {
  tips: [
    "欢迎使用 TRSS-Yunzai QQGuild Plugin ! 作者：时雨🌌星空",
    "参考：https://github.com/TimeRainStarSky/Yunzai-QQGuild-Plugin",
  ],
})

const adapter = new class QQGuildAdapter {
  constructor() {
    this.id = "QQGuild"
    this.name = "QQ频道Bot"
    this.version = `qq-guild-bot v2.9.5`

    switch (typeof config.toQRCode) {
      case "boolean":
        this.toQRCodeRegExp = config.toQRCode ? urlRegexSafe() : false
        break
      case "string":
        this.toQRCodeRegExp = new RegExp(config.toQRCode, "g")
        break
      case "object":
        this.toQRCodeRegExp = urlRegexSafe(config.toQRCode)
        break
    }
  }

  async makeImage(data, image, content) {
    image = await Bot.Buffer(image, { http: true })
    if (Buffer.isBuffer(image)) {
      Bot.makeLog("info", `发送图片：(Buffer)`, data.self_id)
    } else {
      Bot.makeLog("info", `发送图片：${image}`, data.self_id)
      return { image, content, msg_id: data.message_id }
    }

    const formdata = new FormData
    formdata.set("file_image", new Blob([image]))
    if (content)
      formdata.set("content", content)
    if (data.message_id)
      formdata.set("msg_id", data.message_id)
    return formdata
  }

  async makeQRCode(data) {
    return (await QRCode.toDataURL(data)).replace("data:image/png;base64,", "base64://")
  }

  async makeContent(content, sendImage) {
    const match = content.match(this.toQRCodeRegExp)
    if (match) for (const i of match) {
      await sendImage(await this.makeQRCode(i))
      content = content.replace(i, "[链接(请扫码查看)]")
    }
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  parseContent(content) {
    return content.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
  }

  async sendMsg(data, send, msg) {
    if (!Array.isArray(msg))
      msg = [msg]
    let content = ""
    const msgs = []
    const message_id = []
    const ret = []
    const sendImage = async file => {
      ret.push(await send(await this.makeImage(data, file, content)))
      content = ""
    }

    for (let i of msg) {
      if (typeof i !== "object")
        i = { type: "text", text: i }

      switch (i.type) {
        case "text":
          content += await this.makeContent(i.text, sendImage)
          break
        case "image":
          await sendImage(i.file)
          break
        case "face":
          content += `<emoji:${i.id}>`
          break
        case "reply":
          data.message_id = i.id
          data.message_reference = { message_id: i.id }
          break
        case "at":
          if (i.qq === "all")
            content += "@everyone"
          else
            content += `<@${i.qq?.replace?.(/^qg_/, "")}>`
          break
        case "node":
          for (const ret of (await Bot.sendForwardMsg(msg => this.sendMsg(data, send, msg), i.data))) {
            msgs.push(...ret.data)
            message_id.push(...ret.message_id)
          }
          break
        case "button":
          continue
        default:
          content += await this.makeContent(JSON.stringify(i), sendImage)
      }
    }
    if (content)
      ret.push(await send({
        content,
        msg_id: data.message_id,
        message_reference: data.message_reference,
      }))

    for (const i of ret) {
      msgs.push(i)
      if (i.data?.id)
        message_id.push(i.data.id)
    }
    return { data: msgs, message_id }
  }

  async sendFriendMsg(data, msg) {
    if (!data.guild_id) {
      if (!data.source_guild_id) {
        Bot.makeLog("error", `发送好友消息失败：[${data.user_id}] 不存在来源频道信息`, data.self_id)
        return false
      }

      data = {
        ...data,
        ...(await data.bot.api.directMessageApi.createDirectMessage({
          source_guild_id: data.source_guild_id,
          recipient_id: data.user_id,
        })).data,
      }
    }

    return this.sendMsg(data, msg => {
      Bot.makeLog("info", `发送好友消息：[${data.guild_id}, ${data.user_id}] ${JSON.stringify(msg)}`, data.self_id)
      return data.bot.api.directMessageApi.postDirectMessage(data.guild_id, msg)
    }, msg)
  }

  sendGroupMsg(data, msg) {
    return this.sendMsg(data, msg => {
      Bot.makeLog("info", `发送群消息：[${data.channel_id}] ${JSON.stringify(msg)}`, data.self_id)
      return data.bot.api.messageApi.postMessage(data.channel_id, msg)
    }, msg)
  }

  async getMsg(data, message_id) {
    return this.makeMessage({
      msg: (await data.bot.api.messageApi.message(data.channel_id, message_id)).data.message
    })
  }

  async recallMsg(data, message_id, hide = config.recallHide) {
    Bot.makeLog("info", `撤回消息：[${data.channel_id}] ${message_id}`, data.self_id)
    if (!Array.isArray(message_id))
      message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      msgs.push(await data.bot.api.messageApi.deleteMessage(data.channel_id, i, hide))
    return msgs
  }

  async getGroupArray(id) {
    const array = []
    for (const guild of (await Bot[id].api.meApi.meGuilds()).data) try {
      for (const channel of (await Bot[id].api.channelApi.channels(guild.id)).data)
        array.push({
          guild,
          channel,
          group_id: `qg_${guild.id}-${channel.id}`,
          group_name: `${guild.name}-${channel.name}`,
        })
    } catch (err) {
      Bot.makeLog("error", ["获取频道列表错误", err], id)
    }
    return array
  }

  async getGroupList(id) {
    const array = []
    for (const i of (await this.getGroupArray(id)))
      array.push(i.group_id)
    return array
  }

  async getGroupMap(id) {
    for (const i of (await this.getGroupArray(id)))
      Bot[id].gl.set(i.group_id, i)
    return Bot[id].gl
  }

  async getMemberArray(data) {
    const array = []
    for (const i of (await data.bot.api.guildApi.guildMembers(data.guild_id, { limit: 1000 })).data)
      array.push({
        ...i,
        user_id: `qg_${i.user.id}`,
        nickname: i.user.username,
        avatar: i.user.avatar,
        card: i.nick,
      })
    return array
  }

  async getMemberList(data) {
    const array = []
    for (const i of (await this.getMemberArray(data)))
      array.push(i.user_id)
    return array
  }

  async getMemberMap(data) {
    const map = new Map
    for (const i of (await this.getMemberArray(data)))
      map.set(i.user_id, i)
    return map
  }

  getFriendInfo(data) {
    if (data.source_guild_id)
      return this.getMemberInfo(data)
    return data
  }

  async getMemberInfo(data) {
    const i = (await data.bot.api.guildApi.guildMember(data.source_guild_id, data.user_id)).data
    return {
      ...data,
      ...i,
      user_id: `qg_${i.user.id}`,
      nickname: i.user.username,
      avatar: i.user.avatar,
      card: i.nick,
    }
  }

  async getGroupInfo(data) {
    const guild = (await data.bot.api.guildApi.guild(data.guild_id)).data
    const channel = (await data.bot.api.channelApi.channel(data.channel_id)).data
    return {
      ...data,
      guild,
      channel,
      group_id: `qg_${guild.id}-${channel.id}`,
      group_name: `${guild.name}-${channel.name}`,
    }
  }

  pickFriend(id, user_id) {
    if (typeof user_id !== "string")
      user_id = String(user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      getMsg: message_id => this.getMsg(i, message_id),
      recallMsg: (message_id, hide) => this.recallMsg(i, message_id, hide),
      getInfo: () => this.getFriendInfo(i),
      getAvatarUrl: async () => (await this.getFriendInfo(i)).avatar,
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string")
      group_id = String(group_id)
    if (typeof user_id !== "string")
      user_id = String(user_id)
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      source_guild_id: guild_id[0],
      source_channel_id: guild_id[1],
      user_id: user_id.replace(/^qg_/, ""),
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      getInfo: () => this.getMemberInfo(i),
      getAvatarUrl: async () => (await this.getMemberInfo(i)).avatar,
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string")
      group_id = String(group_id)
    const guild_id = group_id.replace(/^qg_/, "").split("-")
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      guild_id: guild_id[0],
      channel_id: guild_id[1],
    }
    return {
      ...i,
      sendMsg: msg => this.sendGroupMsg(i, msg),
      getMsg: message_id => this.getMsg(i, message_id),
      recallMsg: (message_id, hide) => this.recallMsg(i, message_id, hide),
      getMemberArray: () => this.getMemberArray(i),
      getMemberList: () => this.getMemberList(i),
      getMemberMap: () => this.getMemberMap(i),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getInfo: () => this.getGroupInfo(i),
    }
  }

  makeMessage(data) {
    data = { ...data, msg: undefined, ...data.msg }
    data.bot = Bot[data.self_id]
    data.post_type = "message"
    data.user_id = `qg_${data.author.id}`
    data.sender = {
      user_id: data.user_id,
      nickname: data.author.username,
      avatar: data.author.avatar,
    }
    data.message_id = data.id

    data.message = []
    data.raw_message = ""

    if (data.message_reference?.message_id) {
      data.message.push({ type: "reply", id: data.message_reference.message_id })
      data.raw_message += `[回复：${data.message_reference.message_id}]`
    }

    if (data.content) {
      const match = data.content.match(/<@!.+?>/g)
      if (match) {
        let content = data.content
        for (const i of match) {
          const msg = content.split(i)
          const prev_msg = msg.shift()
          if (prev_msg) {
            data.message.push({ type: "text", text: this.parseContent(prev_msg) })
            data.raw_message += prev_msg
          }
          content = msg.join(i)

          const qq = `qg_${i.replace(/<@!(.+?)>/, "$1")}`
          data.message.push({ type: "at", qq })
          data.raw_message += `[提及：${qq}]`
        }
        if (content) {
          data.message.push({ type: "text", text: this.parseContent(content) })
          data.raw_message += content
        }
      } else {
        data.message.push({ type: "text", text: this.parseContent(data.content) })
        data.raw_message += data.content
      }
    }

    if (data.attachments) for (const i of data.attachments) {
      i.type = i.content_type.split("/")[0]
      i.file = i.filename
      if (i.url && !i.url.match(/^https?:\/\//))
        i.url = `http://${i.url}`
      data.message.push(i)
      data.raw_message += JSON.stringify(i)
    }

    delete data.member
    return data
  }

  makeFriendMessage(data) {
    data = this.makeMessage(data)
    data.message_type = "private"
    data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.author,
      ...data.sender,
      guild_id: data.guild_id,
      channel_id: data.channel_id,
    })
    Bot.makeLog("info", `好友消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

    data.reply = msg => this.sendFriendMsg(data, msg)
    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  makeGroupMessage(data) {
    data = this.makeMessage(data)
    data.message_type = "group"
    data.group_id = `qg_${data.guild_id}-${data.channel_id}`
    data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.author,
      ...data.sender,
      source_guild_id: data.guild_id,
      source_channel_id: data.channel_id,
    })
    Bot.makeLog("info", `群消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)

    data.reply = msg => this.sendGroupMsg(data, msg)
    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  message(id, data) {
    data.self_id = id
    switch (data.eventType) {
      case "MESSAGE_CREATE":
        this.makeGroupMessage(data)
        break
      case "MESSAGE_DELETE":
        break
      case "DIRECT_MESSAGE_CREATE":
        this.makeFriendMessage(data)
        break
      case "DIRECT_MESSAGE_DELETE":
        break
      case "AT_MESSAGE_CREATE":
        this.makeGroupMessage(data)
        break
      case "PUBLIC_MESSAGE_DELETE":
        break
      default:
    }
  }

  async connect(token) {
    token = token.split(":")

    const intents = [
      "GUILDS",
      "GUILD_MEMBERS",
      "GUILD_MESSAGE_REACTIONS",
      "DIRECT_MESSAGE",
      "INTERACTION",
      "MESSAGE_AUDIT",
    ]
    if (Number(token[1]))
      intents.push("GUILD_MESSAGES", "FORUMS_EVENT")
    else
      intents.push("PUBLIC_GUILD_MESSAGES", "OPEN_FORUMS_EVENT")

    const bot = {
      ...config.bot,
      appID: token[2],
      token: token[3],
      intents,
      sandbox: Boolean(Number(token[0])),
    }
    bot.api = createOpenAPI(bot)
    bot.ws = createWebsocket(bot)
    bot.ws.on("ERROR", logger.error)
    bot.login = () => bot.ws.connect()
    bot.logout = () => bot.ws.disconnect()

    bot.info = {
      ...(await new Promise(resolve => bot.ws.once("READY", data => resolve(data))))?.msg?.user,
      ...(await bot.api.meApi.me()).data,
    }
    if (!bot.info.id) {
      Bot.makeLog("error", `${this.name}(${this.id}) ${this.version} 连接失败`, token)
      return false
    }

    const id = `qg_${bot.info.id}`
    Bot[id] = bot
    Bot[id].adapter = this
    Bot[id].uin = id
    Bot[id].nickname = Bot[id].info.username
    Bot[id].avatar = Bot[id].info.avatar
    Bot[id].version = {
      id: this.id,
      name: this.name,
      version: this.version,
    }
    Bot[id].stat = { start_time: Date.now() / 1000 }

    Bot[id].pickFriend = user_id => this.pickFriend(id, user_id)
    Bot[id].pickUser = Bot[id].pickFriend

    Bot[id].pickMember = (group_id, user_id) => this.pickMember(id, group_id, user_id)
    Bot[id].pickGroup = group_id => this.pickGroup(id, group_id)

    Bot[id].getGroupArray = () => this.getGroupArray(id)
    Bot[id].getGroupList = () => this.getGroupList(id)
    Bot[id].getGroupMap = () => this.getGroupMap(id)

    Bot[id].fl = new Map
    Bot[id].gl = new Map
    Bot[id].gml = new Map
    Bot[id].getGroupMap()

    Bot[id].ws.on("GUILD_MESSAGES", data => this.message(id, data))
    Bot[id].ws.on("DIRECT_MESSAGE", data => this.message(id, data))
    Bot[id].ws.on("PUBLIC_GUILD_MESSAGES", data => this.message(id, data))

    Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async load() {
    for (const token of config.token)
      await Bot.sleep(5000, this.connect(token))
  }
}

Bot.adapter.push(adapter)

export class QQGuild extends plugin {
  constructor() {
    super({
      name: "QQGuildAdapter",
      dsc: "QQ频道 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#[Qq]+(频道|[Gg]uild)账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Qq]+(频道|[Gg]uild)设置[01]:[01]:[0-9]+:.+$",
          fnc: "Token",
          permission: config.permission,
        }
      ]
    })
  }

  List() {
    this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#[Qq]+(频道|[Gg]uild)设置/, "").trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item !== token)
      this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        this.reply(`账号连接失败`, true)
        return false
      }
    }
    await configSave()
  }
}

logger.info(logger.green("- QQ频道 适配器插件 加载完成"))