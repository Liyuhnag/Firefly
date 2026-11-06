---
title: 为什么 Kubernetes 非要发明 Pod？
published: 2026-10-30
description: 容器是进程，Kubernetes 就是操作系统。可操作系统里的进程从不孤单——它们以进程组为单位协作。本文从 ps 里的一组进程讲起，说清楚 Kubernetes 为什么要把“进程组”做成 Pod：原子调度、Infra 容器、共享 Volume，以及由此长出来的 sidecar 设计模式。
image: ./images/pod-cover.png
tags:
  - Kubernetes
  - 云原生
  - 容器
  - Pod
category: 容器
draft: false
lang: ''
slug: wei-shen-me-you-pod
---

上一篇我们把容器拆到了最底层：容器是被 Namespace 蒙住眼睛、被 Cgroups 拴住手脚、靠 rootfs 拿到一致环境的普通进程；镜像则是给这个进程准备的 .exe 安装包。

那 Kubernetes 是什么？

顺着这个比喻往下走，答案几乎是自动浮现的：如果容器是进程，Kubernetes 就是操作系统。

既然是操作系统，它就得回答操作系统早就回答过的一个问题——进程之间，怎么协作？

这个问题 Linux 已经回答了三十多年，答案就写在 `ps` 的输出里。

## 一、先看看一台真机器上的进程

随便找一台 Linux 服务器，敲 `pstree -g`，会看到一棵树。括号里那个数字是进程组 ID（PGID）：

```text
systemd(1)
├── rsyslogd(1632)
│   ├── {in:imklog}(1632)
│   ├── {in:imuxsock}(1632)
│   └── {rs:main Q:Reg}(1632)
├── acpid(2044)
└── ...
```

重点看 rsyslogd 这一支。它并不“一个进程包打天下”：主循环 main 之外，还有专门读内核日志的 imklog、专门收 socket 日志的 imuxsock——`pstree` 用花括号把它们标成了线程。加上 `-g` 参数后，括号里显示的就不再是 PID，而是进程组 ID，这一支全是 1632。

线程之间传日志几乎零成本：同一块内存、同一个文件描述符表、一条 Unix socket 就够了。而进程组这个数字标记的，是更高一层的边界：同一组的执行单元会被一起管理——收到同一个信号，被同一个作业控制策略管着。无论它们原本是进程还是线程，只要协作依赖“同机”，就都绕不开这个边界。

所以在操作系统里，进程的常态不是“孤苦伶仃”，而是：**一组有强关联的执行单元，共同构成一个最小的部署单元。**

容器给进程套上了沙箱，但并没有废除这条规律，只是把它挡在了沙箱外面。后面你会看到，Kubernetes 做的事，本质上就是把这个“组”的概念搬进了容器世界。

## 二、容器化之后，进程组被拆成了三个容器

现在要把 rsyslogd 容器化。

容器的最佳实践是“一个容器一个进程”（严格说容器里当然能跑多个进程，但那样就退回到“一台小机器”的用法，容器带来的进程级管理也就没了）。于是三个模块被拆成三个独立镜像，跑起来就是三个容器，各配 1 GB 内存，加起来 3 GB。

集群里有两个节点：node-1 空着 3 GB，node-2 空着 2.5 GB。

假设用 Docker Swarm 来跑这件事——那时候 Kubernetes 还没一统江湖。为了让三个容器待在一起，你得给 imklog 和 imuxsock 各加一条亲和性约束：必须和 main 跑在同一台机器上。

然后依次 `docker run main`、`docker run imklog`、`docker run imuxsock`。三个容器进入待调度队列，接下来是这段故事里最要命的部分：

1. main 出队，被调度到 node-2，剩 1.5 GB；
2. imklog 出队，跟着亲和性去了 node-2，剩 0.5 GB；
3. imuxsock 出队，傻了：node-2 只剩 0.5 GB，装不下 1 GB 的它；可亲和性又把它焊死在 node-2 上。

这就是成组调度（gang scheduling）失败的经典样本。

![Swarm 逐个调度会卡在第三个容器，Pod 整体调度一次落地](./images/pod-gang-scheduling.png)

注意，这不是“调度器写错了”。调度器一次只看一个容器，就永远可能把资源切碎——前两个容器都合法落地，第三个必然无家可归。**问题出在粒度上，不在算法上。**

工业界当然早就碰过这个问题，也给出过两种思路：

| 方案 | 做法 | 代价 |
| :--- | :--- | :--- |
| Mesos：资源囤积 | 等所有带亲和性约束的任务都到齐，再统一调度 | 资源空占、调度效率下降，极端情况下会死锁 |
| Google Omega：乐观调度 | 先并发调度，冲突了再回滚重来 | 回滚机制极其复杂，普通团队驾驭不了 |

两种都谈不上完美。这说明“成组”是调度器层面必须解决、而且不好解决的问题。

## 三、Kubernetes 的答案：把“组”变成调度单位

Kubernetes 的解法很直接：既然问题出在粒度上，那就换粒度。

**Pod 是 Kubernetes 的原子调度单位。** 调度器算资源时，不是按容器算，而是按 Pod 里所有容器的总和算。

回到刚才的例子：三个容器合成一个 Pod，资源需求 3 GB。调度器看一眼就知道 node-1 刚好装得下，node-2 差 0.5 GB，于是整个 Pod 绑定到 node-1，一步到位。没有出队顺序，没有“前两个成功、第三个落空”，也不存在“半步”的状态。

这种必须待在一起的关系，有个名字，叫**超亲密关系**。典型特征包括但不限于：

- 容器之间直接交换文件；
- 通过 localhost 或 Unix socket 通信；
- 调用极其频繁，跨机器一趟网络往返就亏了；
- 需要共享某些 Linux Namespace，比如一个容器要加入另一个容器的 Network Namespace。

反过来，超亲密关系是有边界的。PHP 应用和 MySQL 之间当然有访问关系，但一次请求走一次网络毫无压力，也不需要共享文件系统，它们就该是两个 Pod，各自调度、各自扩缩容。**“有关系”不等于“要住一起”。**

## 四、只为了调度，值得新增一个概念吗？

到这里可以停一下，问一个不太客气的问题：

如果 Pod 只是为了解决成组调度，那 Kubernetes 完全可以在调度器里实现，为什么非要把它做成用户必须理解的一等公民？这不是白给所有人加学习成本吗？

这个质疑很合理。Borg 和 Omega 的论文摆在那里，调度层面的问题，工程上总能解决。

Pod 真正的价值在下一层：它不只是调度单位，还是**容器设计模式的载体**。

要理解这一层，得先看 Pod 到底是怎么被造出来的。

## 五、Pod 是怎么被“创建”出来的

**关于 Pod 最重要的一件事是：它只是一个逻辑概念。**

Kubernetes 并不存在一个叫 Pod 的隔离环境，也没有 Pod 自己的 Namespace 和 Cgroups。真正落到宿主机上的，仍然是一个个 Linux 容器。Pod 只是 API 里的一组约定。

那这组约定是什么？

答案是：**Pod 是一组共享了某些资源的容器。** 具体说，Pod 里所有容器共享同一个 Network Namespace，并且可以声明共享同一个 Volume。

![Infra 容器撑起 Network Namespace，用户容器加入其中并共享 Volume](./images/pod-infra-architecture.png)

### 朴素方案：让 A 加入 B

既然只是共享，最直接的想法是让一个容器加入另一个容器的 Network Namespace，顺便继承它的 Volume：

```bash
$ docker run --net=B --volumes-from=B --name=A image-A ...
```

看起来完全够用。但这个方案有三个躲不开的坑：

1. **顺序变成了拓扑。** B 必须先启动，A 才能加入。A 和 B 原本是对等的协作关系，现在被迫变成“谁先谁后”的父子关系。
2. **B 成了单点。** B 一旦退出，它的 Network Namespace 就没了，A 的网络随之消失。可 B 本来只是个提供网络的辅助角色，凭什么决定整个组的生死？
3. **用户被迫当基础设施管理员。** 谁来启动 B、B 用什么镜像、B 挂了要不要重启——这些本该是平台的事，最后都甩给了用户。

### Infra 容器：给 Pod 找一个“房东”

Kubernetes 的解法是插一个中间人：**Infra 容器**。

它永远是这个 Pod 里第一个被创建的容器。它启动后什么都不干，只做一件事——把 Network Namespace 撑住。之后所有用户容器，都以“加入这个 Namespace”的方式挂到它身上。

这样，A 和 B 又恢复了对等：谁也不依赖谁先启动，它们共同依赖那个透明的 Infra 容器。

这个容器用的镜像很特殊：`pause`。它小得离谱，解压后只有 100~200 KB，核心逻辑就是调一次 `pause()` 系统调用然后永不返回。它不消费 CPU，几乎不占内存，存在的唯一意义就是“活着，并持有那个 Namespace”。

由此，Pod 里所有容器获得了一组共同的性质：

- 直接用 localhost 互相通信；
- 看到的网络设备完全一样；
- 整个 Pod 只有一个 IP，就是这个 Network Namespace 的 IP；
- 网络资源一份，被所有容器共享；
- Pod 的生命周期与 Infra 容器一致，而与 A、B 各自无关。

### 给网络插件开发者的两条忠告

这条设计有个容易被忽略的推论：同一个 Pod 里所有用户容器的进出流量，都可以认为是通过 Infra 容器完成的。

所以如果你要给 Kubernetes 写网络插件（CNI），重点应该放在“怎么配好这个 Pod 的 Network Namespace”，而不是“每个用户容器怎么用我的网络配置”——后者没有意义，因为容器自己独立的网络栈并不存在。

顺着这条推论还有两条忠告：

- 别指望在容器里装包或改配置来完成网络配置。Infra 容器的 rootfs 里几乎什么都没有，你没有发挥空间。
- 也正因为如此，网络插件完全不必关心用户容器什么时候启动，只要把 Infra 容器的 Network Namespace 配好就行。

> **镜像地址小贴士**：如果你在旧教程里看到 `k8s.gcr.io/pause`，那是历史遗留——这个地址在 2023 年 4 月就被冻结了，现在统一走 `registry.k8s.io/pause`（目前是 3.10）。另外在 CRI 里，这层“沙箱”有个正式名字叫 pod sandbox，kubelet 创建 Pod 的第一步就是调用 `RunPodSandbox`。

### 共享 Volume 为什么变简单了

有了 Infra 容器这一层，共享 Volume 的实现就顺理成章：Kubernetes 只要把所有 Volume 的定义都放在 Pod 层级。

这样一来，一个 Volume 对应的宿主机目录对 Pod 来说就只有一份。里面的容器只要声明挂载它，就一定能看到同一份数据。比如：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: two-containers
spec:
  restartPolicy: Never
  volumes:
    - name: shared-data
      hostPath:
        path: /data
  containers:
    - name: nginx-container
      image: nginx
      volumeMounts:
        - name: shared-data
          mountPath: /usr/share/nginx/html
    - name: debian-container
      image: debian
      volumeMounts:
        - name: shared-data
          mountPath: /pod-data
      command: ["/bin/sh"]
      args: ["-c", "echo Hello > /pod-data/index.html"]
```

`shared-data` 是 hostPath 类型，对应宿主机上的 `/data` 目录，被同时绑定挂载进两个容器。所以 nginx 能从自己的 `/usr/share/nginx/html` 里，读到 debian 容器刚写下的 `index.html`。

到这里，Pod 的物理形态就清楚了：**它不是一个隔离环境，而是一组通过 Infra 容器共享网络、通过 Volume 共享文件系统的容器集合。**

有了这块“共享”的地基，容器设计模式才有地方生根。

## 六、容器设计模式：sidecar 与 Init Container

### 例子一：WAR 包和 Tomcat

手上有一个 Java Web 应用，WAR 包必须放进 Tomcat 的 webapps 目录才能跑。如果只有 Docker，你会怎么处理这个“组合关系”？

两条路，都不舒服：

- **把 WAR 包塞进 Tomcat 镜像**，做成新镜像。每次改 WAR 包、升 Tomcat，都要重新构建、重新发布。
- **只发布 Tomcat 容器**，用 hostPath 把宿主机上的 WAR 包目录挂进 webapps。那就得保证每台节点上都预先准备好这个目录——等于自建一套分布式存储。

有了 Pod，这条路突然就通了：把 WAR 包和 Tomcat 分别做成镜像，作为同一个 Pod 里的两个容器“组合”起来。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: javaweb
spec:
  initContainers:
    - name: war
      image: geektime/sample:v2
      command: ["cp", "/sample.war", "/app"]
      volumeMounts:
        - name: app-volume
          mountPath: /app
  containers:
    - name: tomcat
      image: geektime/tomcat:7.0
      command: ["sh", "-c", "/root/apache-tomcat-7.0.42-v2/bin/start.sh"]
      volumeMounts:
        - name: app-volume
          mountPath: /root/apache-tomcat-7.0.42-v2/webapps
      ports:
        - containerPort: 8080
          hostPort: 8001
  volumes:
    - name: app-volume
      emptyDir: {}
```

注意 war 这个容器的类型不是普通容器，而是 **Init Container**（镜像名只是示意，重点在 `initContainers` 和共享卷这两处）。

Init Container 的语义很明确：它比 `spec.containers` 里的所有用户容器都先启动，按声明顺序逐个运行，跑完就退出；只有它们全部成功退出，用户容器才会启动。

于是流程变成了：war 容器启动，执行 `cp /sample.war /app`，把包拷进共享卷，然后退出；Tomcat 容器接着启动，它的 webapps 目录正好挂着同一个卷，于是 `sample.war` 已经在那里了。

### sidecar：辅助容器伺候主容器

上面这种“组合”操作，是容器设计模式里最常用的一种，名字叫 **sidecar**。

sidecar 是摩托车的边斗：主容器是摩托，负责往前跑；sidecar 挂在旁边，负责一些主容器不该操心的杂活——准备配置文件、同步证书、收集日志、代理流量。

在这个例子里，Tomcat 是主容器，war 容器就是个 sidecar：它存在的唯一目的，是给主容器递一个 WAR 包。

### 例子二：日志收集

一个应用不停往 `/var/log` 写日志，你想把它们收走。

不需要改应用，也不需要让它内建上报逻辑：把 Pod 的一个 Volume 挂到应用容器的 `/var/log` 上，再在同一个 Pod 里跑一个 sidecar，也挂同一个 Volume。sidecar 只做一件事——盯着 `/var/log`，把新内容转发到 Elasticsearch 或对象存储。

应用只管写文件，收集逻辑完全外置。换收集端、改格式、加脱敏，都不用动业务镜像。

### 例子三：Service Mesh，sidecar 的极致形态

前面两个例子靠共享 Volume 传文件。但别忘了，Pod 的容器还共享 Network Namespace——这意味着网络层面的杂活，也能交给 sidecar。

Istio 就是这么干的：给每个业务 Pod 注入一个 Envoy 容器，它和业务容器共享网络命名空间，再通过 iptables 规则把业务容器的进出流量劫持到自己这里。加密、重试、熔断、限流、链路追踪，全在 Envoy 里完成，业务容器一行代码都不用改。

这就是 Service Mesh（服务网格）的数据面。而它能成立，前提正是 Pod 里“一个网络命名空间、多个容器共享”这条设定。

### 一点补注：sidecar 后来被“转正”了

前面这些例子里，sidecar 要么是 Init Container（必须跑完退出），要么是普通容器（和主容器同生共死）。前者的问题是“跑完就得死”，后者的问题是“sidecar 可能比主容器先挂，主容器的启动顺序也没法保证”。

Kubernetes 1.28 以 Alpha 引入了原生 sidecar（`SidecarContainers` 特性），1.29 进入 Beta，后来正式 GA：写在 `initContainers` 里，但带上 `restartPolicy: Always`。它会在主容器之前启动、之后终止，却不阻塞主容器启动，生命周期与 Pod 对齐。日志采集、代理这类常驻辅助进程，终于有了正规写法。

当然，无论写法怎么变，前面的原理依然成立：它们仍然共享同一个网络命名空间和 Volume。

## 七、几个容易踩的边界

### Pod 不是虚拟机

它没有内核、没有独立操作系统、没有“登进去装点东西”的空间。Pod 里所有容器共享宿主机的内核，隔离强度只到 Namespace 和 Cgroups 这一层。把 Pod 当小虚拟机用，是很多设计跑偏的起点。

### 不是所有“有关系”的容器都该进同一个 Pod

判断标准不是“它们要不要通信”，而是“它们要不要以同一个身份调度、扩缩容、生死与共”。

- 应用 + 日志采集 + 流量代理：该在一起，因为它们的生命周期必须同步。
- 应用 + 数据库：不该在一起，因为扩缩容的节奏完全不同，一个要 3 个副本，另一个只要 1 个主库。

记住：**一个 Pod 就是一个部署单元，扩容时是整体复制的。** 把不该绑定的东西绑进去，扩缩容就被捆死了。

### Pod 的生命周期很短，IP 会变

Pod 是“用完即弃”的。容器崩了、节点被驱逐、滚动更新，Pod 都会被重建，新 Pod 的 IP 大概率不一样。

所以不要在任何地方写死 Pod IP，也不要指望通过 IP 访问它——用 Service 和 DNS 名。这条不是最佳实践，是硬约束。

### 一个 Pod 里的容器越多，麻烦越多

启动顺序、健康检查、资源抢占、日志混在一起、故障定位变难。sidecar 解决的是“辅助逻辑不该污染主镜像”，不是“什么都能往里塞”。能用 Deployment、Service、ConfigMap 解决的，就别加容器。

## 八、收尾：Pod 是 Kubernetes 给“一组必须待在一起的进程”起的名字

回到最开始那棵树。操作系统里，rsyslogd 的三个进程以进程组的方式协作；到了 Kubernetes 里，这套协作关系被原样搬进了容器世界，只是换了个名字，叫 Pod。

所以 Pod 有三重身份，一层比一层深：

1. **调度单位**：调度器按 Pod 而不是容器算资源，成组调度一次到位，不会出现“前两个成功、第三个落空”；
2. **共享资源的容器组**：通过 Infra 容器共享 Network Namespace，通过 Pod 级 Volume 共享文件系统，容器之间因此对等；
3. **容器设计模式的载体**：共享的地基之上，长出了 sidecar、Init Container 这些组合方式，Service Mesh 是它最极致的形态。

一句话记住：

> Pod 不是一个隔离环境，而是一组共享 Network Namespace 与 Volume 的容器；它既是 Kubernetes 的原子调度单位，也是容器设计模式的载体。

下一篇，我们把 Pod 交给控制器：它怎么被复制成多个副本，怎么滚动更新，又怎么在节点挂掉时自己长回来。

---

> **参考资料与说明**
>
> - 本文的叙事结构，以及 rsyslogd 进程组、WAR + Tomcat、日志 sidecar 这几个案例，来自张磊《深入剖析 Kubernetes》（极客时间）。
> - [Borg, Omega, and Kubernetes](https://queue.acm.org/detail.cfm?id=2898444)，ACM Queue，2016
> - [Kubernetes 官方文档：Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
