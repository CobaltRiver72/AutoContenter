module.exports = {
  apps: [{
    name: 'hdf-autopub',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '450M',
    node_args: '--max-old-space-size=512 --expose-gc',
    env: {
      NODE_ENV: 'production'
    },
    // Restart with exponential backoff on crash
    exp_backoff_restart_delay: 1000,
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 10000,
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
