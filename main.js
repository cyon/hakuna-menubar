const {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  systemPreferences,
  shell,
  nativeTheme
} = require('electron')
const path = require('path')
const Client = require('hakuna-client')
const config = new (require('electron-config'))()
const moment = require('moment')
const leftPad = require('left-pad')
const { exec } = require('child_process')
const AutoLaunch = require('auto-launch')

const autoLauncher = new AutoLaunch({
  name: 'Hakuna Menubar',
  path: '/Applications/Hakuna Menubar.app'
})

var tray = null
var preferencesWindow = null
var client = null
var interval = null
var contextMenu = null

app.on('ready', () => {
  if (typeof config.get('showName') === 'undefined') {
    config.set('showName', true)
    config.set('showOvertime', true)
    config.set('showVacationDays', true)
  }

  if (!config.get('company') || !config.get('apiKey')) {
    showPreferencesWindow()
    return
  }

  client = new Client({
    authToken: config.get('apiKey'),
    company: config.get('company')
  })

  client.overview((err, result) => {
    if (!err) return initTray()

    showPreferencesWindow()
  })
})

async function initTray () {
  hideDock()
  let autoLaunchEnabled = await autoLauncher.isEnabled()

  if (!tray) {
    var darkMode = nativeTheme.shouldUseDarkColors
    tray = new Tray(path.join(__dirname, `/tray-icon-${darkMode ? 'dark' : 'light'}.png`))
    tray.on('click', toggleTimer)
    tray.on('right-click', displayContextMenu)
    if (interval) clearInterval(interval)
    interval = setInterval(setCurrentTime, 1000 * 10)
    setCurrentTime()
  }

  let tasks = await client.listTasks()
  let user = await client.getOwnUser()
  let overview = await client.overview()

  let currentTask = config.get('taskId')

  if (!currentTask) {
    currentTask = tasks.find((task) => !task.archived && task.name.includes('Arbeit'))
    if (!currentTask) currentTask = tasks[0]

    currentTask = currentTask.id
    config.set('taskId', currentTask)
  }

  let template = []
  if (config.get('showName')) {
    template.push({ label: `${user.name}, ${user.email}`, enabled: false })
  }

  if (config.get('showOvertime')) {
    template.push({ label: `Overtime: ${overview.overtime}`, enabled: false })
  }

  if (config.get('showVacationDays')) {
    template.push({ label: `Remaining vacation days: ${overview.vacation.remaining_days}`, enabled: false })
  }

  if (template.length !== 0) {
    template.push({ type: 'separator' })
  }

  contextMenu = Menu.buildFromTemplate([
    ...template,
    { label: 'Open website', click: () => { shell.openExternal(`https://${config.get('company')}.hakuna.ch`) } },
    {
      label: 'Task Type',
      submenu: tasks.map((task) => {
        return {
          type: 'radio',
          label: task.name,
          checked: task.id === currentTask,
          click: () => { config.set('taskId', task.id) }
        }
      })
    },
    { type: 'separator' },
    {
      label: 'Preferences',
      submenu: [
        {
          type: 'checkbox',
          label: 'Show Name',
          checked: config.get('showName'),
          click: () => {
            config.set('showName', !config.get('showName'))
            initTray()
          }
        },
        {
          type: 'checkbox',
          label: 'Show Overtime',
          checked: config.get('showOvertime'),
          click: () => {
            config.set('showOvertime', !config.get('showOvertime'))
            initTray()
          }
        },
        {
          type: 'checkbox',
          label: 'Show Vacation Days',
          checked: config.get('showVacationDays'),
          click: () => {
            config.set('showVacationDays', !config.get('showVacationDays'))
            initTray()
          }
        },
        {
          type: 'checkbox',
          label: 'Launch on startup',
          checked: autoLaunchEnabled,
          click: async () => {
            if (autoLaunchEnabled) {
              await autoLauncher.disable()
            } else {
              await autoLauncher.enable()
            }
            initTray()
          }
        }
      ]
    },
    { type: 'separator' },
    { label: 'Give feedback', click: () => { shell.openExternal(`https://www.github.com/cyon/hakuna-menubar/issues/new`) } },
    { label: 'Quit', click: () => { app.quit() } }
  ])
}

function displayContextMenu () {
  tray.popUpContextMenu(contextMenu)
}

function toggleTimer () {
  client.getTimer((err, timer) => {
    if (!timer.date) {
      var afterStartTrigger = config.get('triggers.afterStart', null)
      if (afterStartTrigger) {
        exec(afterStartTrigger)
      }
      client.startTimer(config.get('taskId'), () => {
        setCurrentTime()
      })
      return
    }

    var afterStopTrigger = config.get('triggers.afterStop', null)
    if (afterStopTrigger) {
      exec(afterStopTrigger)
    }
    client.stopTimer(() => {
      setCurrentTime()
    })
  })
}

function hideDock () {
  if (typeof app.dock !== 'undefined') app.dock.hide()
}

function showDock () {
  if (typeof app.dock !== 'undefined') app.dock.show()
}

function showPreferencesWindow () {
  if (!preferencesWindow) {
    preferencesWindow = new BrowserWindow({
      width: 400,
      height: 300,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })
    preferencesWindow.loadURL(`file://${__dirname}/preferences.html`)
    preferencesWindow.show()
    preferencesWindow.openDevTools()
    Menu.setApplicationMenu(Menu.buildFromTemplate(
      [
        { role: 'appMenu' },
        {
          role: 'editMenu',
          submenu: [
            { role: 'copy' },
            { role: 'paste' },
            { role: 'cut' },
          ]
        },
      ])
    )
  }
}

ipcMain.on('login', (evt, values) => {
  client = new Client({
    authToken: values.apiKey,
    company: values.companyName
  })

  client.overview((err, result) => {
    evt.sender.send('login-reply', (err === null))

    if (err) return

    config.set('company', values.companyName)
    config.set('apiKey', values.apiKey)

    setTimeout(() => {
      preferencesWindow.hide()
    }, 2000)

    initTray()
  })
})

function setCurrentTime () {
  var previousMinutes = 0
  client.listTimeEntries(moment().format('YYYY-MM-DD'), (err, entries) => {
    entries.map((entry) => {
      previousMinutes += (entry.duration_in_seconds / 60)
    })

    client.getTimer((err, timer) => {
      var darkMode = nativeTheme.shouldUseDarkColors

      if (!timer.date) {
        var trayIconPlay = (darkMode ? 'tray-icon-play-dark@2x.png' : 'tray-icon-play-light.png')
        tray.setImage(path.join(__dirname, trayIconPlay))
        var previousHours = Math.floor(previousMinutes / 60)
        var previousMinutesLeft = previousMinutes - (previousHours * 60)
        tray.setTitle(`${leftPad(previousHours, 2, 0)}:${leftPad(previousMinutesLeft, 2, 0)}`)
        return
      }

      var trayIconPause = (darkMode ? 'tray-icon-pause-dark.png' : 'tray-icon-pause-light.png')
      tray.setImage(path.join(__dirname, trayIconPause))

      var startTime = moment(timer.date + ' ' + timer.start_time)
      var minutes = moment().diff(startTime, 'minutes') + previousMinutes
      var hours = Math.floor(minutes / 60)
      var minutesLeft = minutes - (hours * 60)

      tray.setTitle(`${leftPad(hours, 2, 0)}:${leftPad(minutesLeft, 2, 0)}`)
    })
  })
}
