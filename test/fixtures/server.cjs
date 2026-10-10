'use strict';
const express = require('express');
const { db } = require("./db");
const routes = require('./routes/index.js');
const path = require.resolve('./worker');
module.exports = function start() { return express().use(routes); };
