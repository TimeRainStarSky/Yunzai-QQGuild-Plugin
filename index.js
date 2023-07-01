logger.info(logger.yellow("- 正在加载 QQ频道 插件"))

import { config, configSave } from "./Model/config.js"
import { createOpenAPI, createWebsocket } from "qq-guild-bot"
import { FormData, Blob } from "formdata-node"

const adapter = new class QQGuildAdapter {
  constructor() {
    this.id = "QQGuild"
    this.name = "QQ频道Bot"
  }

  sendImage(data, send, file) {
    logger.info(`${logger.blue(`[${data.self_id}]`)} 发送图片：${file.replace(/^base64:\/\/.*/, "base64://...")}`)
    if (file.match(/^base64:\/\//)) {
      const formdata = new FormData()
      if (data.message_id)
        formdata.set("msg_id", data.message_id)
      formdata.set("file_image", new Blob([Buffer.from(file.replace(/^base64:\/\//, ""), "base64")]))
      return send(formdata)
    } else {
      return send({ image: file, msg_id: data.message_id })
    }
  }

  async sendMsg(data, send, msg) {
    if (!Array.isArray(msg))
      msg = [msg]
    let message = ""
    const msgs = []
    const message_id = []
    const ret = []
    for (let i of msg) {
      if (typeof i != "object")
        i = { type: "text", data: { text: i } }
      else if (!i.data)
        i = { type: i.type, data: { ...i, type: undefined } }
      switch (i.type) {
        case "text":
          message += i.data.text
          break
        case "image":
          ret.push(await this.sendImage(data, send, i.data.file))
          break
        case "face":
          message += `<emoji:${i.data.id}>`
          break
        case "reply":
          data.message_id = i.data.id
          break
        case "at":
          if (i.data.qq == "all")
            message += "@everyone"
          else
            message += `<@${i.data.qq}>`
          break
        case "node":
          for (const ret of (await this.sendForwardMsg(msg => this.sendMsg(data, send, msg), i.data))) {
            msgs.push(...ret.data)
            message_id.push(...ret.message_id)
          }
          break
        default:
          message += JSON.stringify(i)
      }
    }
    if (message)
      ret.push(await send({ content: message, msg_id: data.message_id }))

    for (const i of ret) {
      msgs.push(i)
      if (i?.data?.id)
        message_id.push(i.data.id)
    }
    return { data: msgs, message_id }
  }

  async sendFriendMsg(data, msg) {
    if (!data.guild_id) {
      if (!data.source_guild_id) {
        logger.error(`${logger.blue(`[${data.self_id}]`)} 发送好友消息失败：[${data.user_id}] 不存在来源频道信息`)
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
      logger.info(`${logger.blue(`[${data.self_id}]`)} 发送好友消息：[${data.guild_id}, ${data.user_id}] ${JSON.stringify(msg)}`)
      return data.bot.api.directMessageApi.postDirectMessage(data.guild_id, msg)
    }, msg)
  }

  sendGroupMsg(data, msg) {
    return this.sendMsg(data, msg => {
      logger.info(`${logger.blue(`[${data.self_id}]`)} 发送群消息：[${data.channel_id}] ${JSON.stringify(msg)}`)
      return data.bot.api.messageApi.postMessage(data.channel_id, msg)
    }, msg)
  }

  async recallMsg(data, message_id, hide) {
    logger.info(`${logger.blue(`[${data.self_id}]`)} 撤回消息：${message_id}`)
    if (!Array.isArray(message_id))
      message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      msgs.push(await data.bot.api.messageApi.deleteMessage(data.channel_id, i, hide))
    return msgs
  }

  async sendForwardMsg(send, msg) {
    const messages = []
    for (const i of msg)
      messages.push(await send(i.message))
    return messages
  }

  async getGroupArray(id) {
    const array = []
    for (const guild of (await Bot[id].api.meApi.meGuilds()).data) try {
      for (const channel of (await Bot[id].api.channelApi.channels(guild.id)).data)
        array.push({
          ...guild,
          ...channel,
          group_id: `${guild.id}-${channel.id}`,
          group_name: `${guild.name}-${channel.name}`,
        })
    } catch (err) {
      logger.error(`获取频道列表错误：${logger.red(JSON.stringify(err))}`)
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
    const map = new Map()
    for (const i of (await this.getGroupArray(id)))
      map.set(i.group_id, i)
    return map
  }

  getFriendInfo(data) {
    if (data.source_guild_id)
      return this.getMemberInfo(data)
    return data
  }

  async getMemberInfo(data) {
    const info = (await data.bot.api.guildApi.guildMember(data.source_guild_id, data.user_id)).data
    return {
      ...data,
      ...info,
      user_id: info.user.id,
      nickname: info.nick,
      avatar: info.user.avatar,
    }
  }

  async getGroupInfo(data) {
    const guild = (await data.bot.api.guildApi.guild(data.guild_id)).data
    const channel = (await data.bot.api.channelApi.channel(data.channel_id)).data
    return {
      ...data,
      ...guild,
      ...channel,
      group_id: `${guild.id}-${channel.id}`,
      group_name: `${guild.name}-${channel.name}`,
    }
  }

  pickFriend(id, user_id) {
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id,
    }
    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      recallMsg: (message_id, hide) => this.recallMsg(i, message_id, hide),
      makeForwardMsg: Bot.makeForwardMsg,
      sendForwardMsg: msg => this.sendForwardMsg(msg => this.sendFriendMsg(i, msg), msg),
      getInfo: () => this.getFriendInfo(i),
      getAvatarUrl: async () => (await this.getFriendInfo(i)).avatar,
    }
  }

  pickMember(id, group_id, user_id) {
    const guild_id = group_id.split("-")
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      source_guild_id: guild_id[0],
      source_channel_id: guild_id[1],
      user_id,
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      getInfo: () => this.getMemberInfo(i),
      getAvatarUrl: async () => (await this.getMemberInfo(i)).avatar,
    }
  }

  pickGroup(id, group_id) {
    const guild_id = group_id.split("-")
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
      recallMsg: (message_id, hide) => this.recallMsg(i, message_id, hide),
      makeForwardMsg: Bot.makeForwardMsg,
      sendForwardMsg: msg => this.sendForwardMsg(msg => this.sendGroupMsg(i, msg), msg),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getInfo: () => this.getGroupInfo(i),
    }
  }

  makeMessage(data) {
    data.post_type = "message"
    data = { ...data, ...data.msg, msg: undefined }
    data.user_id = data.author.id
    data.sender = {
      user_id: data.user_id,
      nickname: data.author.username,
      avatar: data.author.avatar,
    }
    data.group_id = `${data.guild_id}-${data.channel_id}`
    data.message_id = data.id

    data.message = []
    data.raw_message = ""
    if (data.content) {
      const match = data.content.match(/<@!.+?>/g)
      if (match) {
        let content = data.content
        for (const i of match) {
          const msg = content.split(i)
          const prev_msg = msg.shift()
          if (prev_msg) {
            data.message.push({ type: "text", text: prev_msg })
            data.raw_message += prev_msg
          }
          content = msg.join(i)

          const qq = i.replace(/<@!(.+?)>/, "$1")
          data.message.push({ type: "at", qq })
          data.raw_message += `[提及：${qq}]`
        }
        if (content) {
          data.message.push({ type: "text", text: content })
          data.raw_message += content
        }
      } else {
        data.message.push({ type: "text", text: data.content })
        data.raw_message += data.content
      }
    }

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

    logger.info(`${logger.blue(`[${data.self_id}]`)} 好友消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)
    data.friend = data.bot.pickFriend(data.user_id)
    data.reply = msg => this.sendFriendMsg(data, msg)

    Bot.emit(`${data.post_type}.${data.message_type}`, data)
    Bot.emit(`${data.post_type}`, data)
  }

  makeGroupMessage(data) {
    data = this.makeMessage(data)
    data.message_type = "group"
    data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      ...data.author,
      ...data.sender,
      source_guild_id: data.guild_id,
      source_channel_id: data.channel_id,
    })

    logger.info(`${logger.blue(`[${data.self_id}]`)} 群消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`)
    data.friend = data.bot.pickFriend(data.user_id)
    data.group = data.bot.pickGroup(data.group_id)
    data.member = data.group.pickMember(data.user_id)
    data.reply = msg => this.sendGroupMsg(data, msg)

    Bot.emit(`${data.post_type}.${data.message_type}`, data)
    Bot.emit(`${data.post_type}`, data)
  }

  message(bot, data) {
    data.self_id = bot.uin
    data.bot = bot
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
      appID: token[2],
      token: token[3],
      intents,
      sandbox: Boolean(Number(token[0])),
    }
    bot.api = createOpenAPI(bot)
    bot.ws = createWebsocket(bot)
    bot.ws.on("ERROR", logger.error)

    bot.info = {
      ...(await new Promise(resolve => bot.ws.once("READY", data => resolve(data))))?.msg?.user,
      ...(await bot.api.meApi.me()).data,
    }
    if (!bot.info.id) {
      logger.error(`${logger.blue(`[${token}]`)} ${this.name}(${this.id}) 连接失败`)
      return false
    }

    const id = bot.info.id
    Bot[id] = bot
    Bot[id].uin = id
    Bot[id].nickname = Bot[id].info.username
    Bot[id].avatar = Bot[id].info.avatar
    Bot[id].version = {
      id: this.id,
      name: this.name,
      version: config.package.dependencies["qq-guild-bot"],
    }
    Bot[id].stat = { start_time: Date.now() / 1000 }
    Bot[id].pickFriend = user_id => this.pickFriend(id, user_id)
    Bot[id].pickUser = Bot[id].pickFriend

    Bot[id].pickMember = (group_id, user_id) => this.pickMember(id, group_id, user_id)
    Bot[id].pickGroup = group_id => this.pickGroup(id, group_id)

    Bot[id].getGroupArray = () => this.getGroupArray(id)
    Bot[id].getGroupList = () => this.getGroupList(id)
    Bot[id].getGroupMap = () => this.getGroupMap(id)

    Bot[id].fl = new Map()
    Bot[id].gl = await Bot[id].getGroupMap()

    if (!Bot.uin.includes(id))
      Bot.uin.push(id)

    Bot[id].ws.on("GUILD_MESSAGES", data => this.message(Bot[id], data))
    Bot[id].ws.on("DIRECT_MESSAGE", data => this.message(Bot[id], data))
    Bot[id].ws.on("PUBLIC_GUILD_MESSAGES", data => this.message(Bot[id], data))

    logger.mark(`${logger.blue(`[${id}]`)} ${this.name}(${this.id}) 已连接`)
    Bot.emit(`connect.${id}`, Bot[id])
    Bot.emit(`connect`, Bot[id])
    return true
  }

  async load() {
    for (const token of config.token)
      await adapter.connect(token)
    return true
  }
}

Bot.adapter.push(adapter)

export class QQGuild extends plugin {
  constructor() {
    super({
      name: "QQ频道",
      dsc: "QQ频道",
      event: "message",
      rule: [
        {
          reg: "^#[Qq]+(频道|[Gg]uild)账号$",
          fnc: "List",
          permission: "master"
        },
        {
          reg: "^#[Qq]+(频道|[Gg]uild)设置[01]:[01]:[0-9]+:.+$",
          fnc: "Token",
          permission: "master"
        }
      ]
    })
  }

  async List() {
    await this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
  }

  async Token() {
    const token = this.e.msg.replace(/^#[Qq]+(频道|[Gg]uild)设置/, "").trim()
    if (config.token.includes(token)) {
      config.token = config.token.filter(item => item != token)
      await this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
    } else {
      if (await adapter.connect(token)) {
        config.token.push(token)
        await this.reply(`账号已连接，共${config.token.length}个账号`, true)
      } else {
        await this.reply(`账号连接失败`, true)
        return false
      }
    }
    configSave(config)
  }
}

logger.info(logger.green("- QQ频道 插件 加载完成"))