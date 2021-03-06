const Plugin = require('./Plugin')
const UppySocket = require('../core/UppySocket')
const {
  emitSocketProgress,
  getSocketHost,
  settle
} = require('../core/Utils')

module.exports = class XHRUpload extends Plugin {
  constructor (core, opts) {
    super(core, opts)
    this.type = 'uploader'
    this.id = 'XHRUpload'
    this.title = 'XHRUpload'

    // Default options
    const defaultOptions = {
      formData: true,
      fieldName: 'files[]',
      method: 'post',
      metaFields: null,
      responseUrlFieldName: 'url',
      bundle: true,
      headers: {},
      getResponseData (xhr) {
        return JSON.parse(xhr.response)
      },
      getResponseError (xhr) {
        return new Error('Upload error')
      }
    }

    // Merge default options with the ones set by user
    this.opts = Object.assign({}, defaultOptions, opts)

    this.handleUpload = this.handleUpload.bind(this)
    this.handleRetry = this.handleRetry.bind(this)
    this.handleRetryAll = this.handleRetryAll.bind(this)
  }

  getOptions (file) {
    const opts = Object.assign({},
      this.opts,
      this.core.state.xhrUpload || {},
      file.xhrUpload || {}
    )
    opts.headers = {}
    Object.assign(opts.headers, this.opts.headers)
    if (this.core.state.xhrUpload) {
      Object.assign(opts.headers, this.core.state.xhrUpload.headers)
    }
    if (file.xhrUpload) {
      Object.assign(opts.headers, file.xhrUpload.headers)
    }

    return opts
  }

  createFormDataUpload (file, opts) {
    const formPost = new FormData()

    const metaFields = Array.isArray(opts.metaFields)
      ? opts.metaFields
      // Send along all fields by default.
      : Object.keys(file.meta)
    metaFields.forEach((item) => {
      formPost.append(item, file.meta[item])
    })

    formPost.append(opts.fieldName, file.data)

    return formPost
  }

  createBareUpload (file, opts) {
    return file.data
  }

  upload (file, current, total) {
    const opts = this.getOptions(file)

    this.core.log(`uploading ${current} of ${total}`)
    return new Promise((resolve, reject) => {
      const data = opts.formData
        ? this.createFormDataUpload(file, opts)
        : this.createBareUpload(file, opts)

      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          this.core.emit('core:upload-progress', {
            uploader: this,
            id: file.id,
            bytesUploaded: ev.loaded,
            bytesTotal: ev.total
          })
        }
      })

      xhr.addEventListener('load', (ev) => {
        if (ev.target.status >= 200 && ev.target.status < 300) {
          const resp = opts.getResponseData(xhr)
          const uploadURL = resp[opts.responseUrlFieldName]

          this.core.emit('core:upload-success', file.id, resp, uploadURL)

          if (uploadURL) {
            this.core.log(`Download ${file.name} from ${file.uploadURL}`)
          }

          return resolve(file)
        } else {
          const error = opts.getResponseError(xhr) || new Error('Upload error')
          error.request = xhr
          this.core.emit('core:upload-error', file.id, error)
          return reject(error)
        }
      })

      xhr.addEventListener('error', (ev) => {
        const error = opts.getResponseError(xhr) || new Error('Upload error')
        this.core.emit('core:upload-error', file.id, error)
        return reject(new Error('Upload error'))
      })

      xhr.open(opts.method.toUpperCase(), opts.endpoint, true)

      Object.keys(opts.headers).forEach((header) => {
        xhr.setRequestHeader(header, opts.headers[header])
      })

      xhr.send(data)

      this.core.on('core:upload-cancel', (fileID) => {
        if (fileID === file.id) {
          xhr.abort()
        }
      })

      this.core.on('core:cancel-all', () => {
        // const files = this.core.getState().files
        // if (!files[file.id]) return
        xhr.abort()
      })

      this.core.emit('core:upload-started', file.id)
    })
  }

  uploadRemote (file, current, total) {
    const opts = this.getOptions(file)
    return new Promise((resolve, reject) => {
      this.core.emit('core:upload-started', file.id)

      const fields = {}
      const metaFields = Array.isArray(opts.metaFields)
        ? opts.metaFields
        // Send along all fields by default.
        : Object.keys(file.meta)

      metaFields.forEach((name) => {
        fields[name] = file.meta.name
      })

      fetch(file.remote.url, {
        method: 'post',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(Object.assign({}, file.remote.body, {
          endpoint: opts.endpoint,
          size: file.data.size,
          fieldname: opts.fieldName,
          fields,
          headers: opts.headers
        }))
      })
      .then((res) => {
        if (res.status < 200 && res.status > 300) {
          return reject(res.statusText)
        }

        res.json().then((data) => {
          const token = data.token
          const host = getSocketHost(file.remote.host)
          const socket = new UppySocket({ target: `${host}/api/${token}` })

          socket.on('progress', (progressData) => emitSocketProgress(this, progressData, file))

          socket.on('success', (data) => {
            this.core.emit('core:upload-success', file.id, data, data.url)
            socket.close()
            return resolve()
          })
        })
      })
    })
  }

  uploadFiles (files) {
    const promises = files.map((file, i) => {
      const current = parseInt(i, 10) + 1
      const total = files.length

      if (file.isRemote) {
        return this.uploadRemote(file, current, total)
      } else {
        return this.upload(file, current, total)
      }
    })

    return settle(promises)
  }

  handleUpload (fileIDs) {
    if (fileIDs.length === 0) {
      this.core.log('[XHRUpload] No files to upload!')
      return Promise.resolve()
    }

    this.core.log('[XHRUpload] Uploading...')
    const files = fileIDs.map(getFile, this)
    function getFile (fileID) {
      return this.core.state.files[fileID]
    }

    return this.uploadFiles(files).then(() => null)
  }

  handleRetry (targetFileID) {
    this.handleUpload([targetFileID])
  }

  handleRetryAll (filesToRetry) {
    this.handleUpload(filesToRetry)
  }

  install () {
    this.core.addUploader(this.handleUpload)

    this.core.on('core:upload-retry', this.handleRetry)
    this.core.on('core:retry-all', this.handleRetryAll)
  }

  uninstall () {
    this.core.removeUploader(this.handleUpload)

    this.core.off('core:upload-retry', this.handleRetry)
    this.core.off('core:retry-all', this.handleRetryAll)
  }
}
