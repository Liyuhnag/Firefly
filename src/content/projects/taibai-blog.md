---
title: "taibai 个人博客"
slug: taibai-blog
published: 2026-11-23
description: "用 Firefly 搭建个人博客，把文章、项目记录和开发复盘放在自己的域名下。"
status: published
tags:
  - Astro
  - GitHub Pages
link:
  - label: "访问博客"
    value: "https://taibai.work/"
  - label: "GitHub"
    value: "https://github.com/Liyuhnag/Firefly"
---

## 搭建记录

博客基于 Firefly 主题，通过 GitHub Pages 发布。绑定独立域名后，首页从仓库路径移到了域名根目录，构建时的资源路径也随之改成了 `/`。

## 项目思考

一次域名切换涉及三处配置：DNS 决定访客访问哪台服务器，GitHub Pages 负责域名绑定和证书，Astro 的部署路径决定浏览器去哪里加载样式和图片。这次上线时，DNS 已经生效，HTTPS 证书稍后才就绪。以后切换域名，可以分别验证解析结果、证书和首页资源，更容易定位问题。
