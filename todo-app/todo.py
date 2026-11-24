#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面待办的命令行入口（数据文件就在本脚本旁边）。

人和别的 agent 都用这个改数据，改完小窗 1 秒内自动刷新，不用重启。

    py todo.py list
    py todo.py add "读两篇文献" --due "2026-11-20 18:00" --min 90
    py todo.py done 2          # 2 = list 里显示的序号
    py todo.py undo 2
    py todo.py due 2 "2026-11-21 09:00"
    py todo.py due 2 clear
    py todo.py min 2 45
    py todo.py edit 2 "新文字"
    py todo.py del 2

课表：
    py todo.py cls list
    py todo.py cls add 3 08:00 09:40 生物化学   # 3 = 周三
    py todo.py cls del 1                        # 1 = cls list 里的序号

事务（日程里的一次性安排，带分类）：
    py todo.py ev list
    py todo.py ev add 2026-11-21 10:00 12:00 拍摄 活动剪辑 特殊
    py todo.py ev cat 2 重要                    # 分类：日常 / 特殊 / 重要
"""
import io
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
TODO = os.path.join(BASE, "todos.txt")
CLASS = os.path.join(BASE, "classes.txt")
EVENT = os.path.join(BASE, "events.txt")
ARCHIVE = os.path.join(BASE, "archive.txt")

DUE_FMT = "%Y-%m-%d %H:%M"
WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def read_lines(path):
    if not os.path.exists(path):
        return []
    with io.open(path, "r", encoding="utf-8") as f:
        return [ln.rstrip("\r\n") for ln in f if ln.strip()]


def write_lines(path, lines):
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="") as f:
        for ln in lines:
            f.write(ln + "\r\n")
    os.replace(tmp, path)


def load_todos():
    out = []
    for ln in read_lines(TODO):
        p = ln.split("\t")
        if len(p) < 2:
            continue
        item = {"done": p[0].strip() == "1", "due": "", "min": "", "prio": "", "text": ""}
        if len(p) >= 5:
            item["due"], item["min"], item["prio"], item["text"] = p[1], p[2], p[3].strip().upper(), p[4]
        elif len(p) >= 4:
            item["due"], item["min"], item["text"] = p[1], p[2], p[3]
        elif len(p) == 3:
            item["due"], item["text"] = p[1], p[2]
        else:
            item["text"] = p[1]
        out.append(item)
    return out


def save_todos(items):
    lines = []
    for it in items:
        lines.append("\t".join([
            "1" if it["done"] else "0",
            it.get("due", "") or "",
            it.get("min", "") or "",
            it.get("prio", "") or "",
            it["text"].replace("\t", " ").replace("\n", " "),
        ]))
    write_lines(TODO, lines)


def show_todos():
    items = load_todos()
    if not items:
        print("(空)")
        return
    for i, it in enumerate(items, 1):
        mark = "[x]" if it["done"] else "[ ]"
        due = it["due"] or "-"
        mn = it["min"] + "分" if it["min"] else "-"
        pr = it.get("prio") or "-"
        print("%2d %s [%s] %-24s 截止:%-18s 耗时:%s" % (i, mark, pr, it["text"], due, mn))


def idx(argv, n):
    if len(argv) < n:
        print("缺少序号")
        sys.exit(2)
    try:
        return int(argv[1]) - 1
    except ValueError:
        print("序号要是数字")
        sys.exit(2)


def load_classes():
    out = []
    for ln in read_lines(CLASS):
        p = ln.split("\t")
        if len(p) < 4:
            continue
        out.append({"day": int(p[0]), "start": p[1], "end": p[2], "name": p[3]})
    return out


def save_classes(items):
    lines = ["%d\t%s\t%s\t%s" % (c["day"], c["start"], c["end"], c["name"]) for c in items]
    write_lines(CLASS, lines)


def load_archive():
    return load_todos_file(ARCHIVE)


def load_todos_file(path):
    out = []
    for ln in read_lines(path):
        p = ln.split("\t")
        if len(p) < 2:
            continue
        item = {"done": p[0].strip() == "1", "due": "", "min": "", "prio": "", "text": ""}
        if len(p) >= 5:
            item["due"], item["min"], item["prio"], item["text"] = p[1], p[2], p[3].strip().upper(), p[4]
        elif len(p) >= 4:
            item["due"], item["min"], item["text"] = p[1], p[2], p[3]
        elif len(p) == 3:
            item["due"], item["text"] = p[1], p[2]
        else:
            item["text"] = p[1]
        out.append(item)
    return out


def save_todos_file(path, items):
    lines = []
    for it in items:
        lines.append("\t".join([
            "1" if it["done"] else "0",
            it.get("due", "") or "",
            it.get("min", "") or "",
            it.get("prio", "") or "",
            it["text"].replace("\t", " ").replace("\n", " "),
        ]))
    write_lines(path, lines)


CATS = ["日常", "特殊", "重要"]


def norm_cat(v):
    v = (v or "").strip()
    return v if v in CATS else "日常"


def load_events():
    out = []
    for ln in read_lines(EVENT):
        p = ln.split("\t")
        if len(p) < 5:
            continue
        cat = norm_cat(p[5]) if len(p) > 5 else "日常"
        out.append({"date": p[0], "start": p[1], "end": p[2], "kind": p[3], "name": p[4], "cat": cat})
    return out


def save_events(items):
    items.sort(key=lambda e: (e["date"], e["start"]))
    write_lines(EVENT, ["%s\t%s\t%s\t%s\t%s\t%s" % (e["date"], e["start"], e["end"], e["kind"], e["name"],
                                                   norm_cat(e.get("cat")))
                        for e in items])


def main():
    a = sys.argv[1:]
    if not a:
        show_todos()
        return

    cmd = a[0]

    if cmd == "list":
        show_todos()
        return

    if cmd == "add":
        if len(a) < 2:
            print("缺少文字")
            sys.exit(2)
        text = a[1]
        due = ""
        mn = ""
        pr = ""
        i = 2
        while i < len(a):
            if a[i] == "--due" and i + 1 < len(a):
                due = a[i + 1]
                i += 2
            elif a[i] == "--min" and i + 1 < len(a):
                mn = a[i + 1]
                i += 2
            elif a[i] == "--prio" and i + 1 < len(a):
                pr = a[i + 1].upper()
                i += 2
            else:
                i += 1
        items = load_todos()
        pos = len(items)
        for k, it in enumerate(items):
            if it["done"]:
                pos = k
                break
        items.insert(pos, {"done": False, "due": due, "min": mn, "prio": pr, "text": text})
        save_todos(items)
        print("已添加：" + text)
        return

    if cmd in ("done", "undo"):
        items = load_todos()
        i = idx(a, 1)
        if not (0 <= i < len(items)):
            print("序号越界")
            sys.exit(2)
        items[i]["done"] = cmd == "done"
        save_todos(items)
        print(("已完成：" if cmd == "done" else "已恢复：") + items[i]["text"])
        return

    if cmd in ("due", "min", "edit", "del"):
        items = load_todos()
        i = idx(a, 1)
        if not (0 <= i < len(items)):
            print("序号越界")
            sys.exit(2)
        if cmd == "del":
            t = items.pop(i)
            save_todos(items)
            print("已删除：" + t["text"])
        elif cmd == "edit":
            if len(a) < 3:
                print("缺少文字")
                sys.exit(2)
            items[i]["text"] = a[2]
            save_todos(items)
            print("已改为：" + a[2])
        elif cmd == "due":
            v = "" if (len(a) < 3 or a[2] == "clear") else a[2]
            items[i]["due"] = v
            save_todos(items)
            print("截止时间：" + (v or "已清除"))
        elif cmd == "min":
            v = "" if (len(a) < 3 or a[2] == "clear") else a[2]
            items[i]["min"] = v
            save_todos(items)
            print("预计耗时：" + (v + " 分" if v else "已清除"))
        return

    if cmd == "archive":
        todos = load_todos()
        done = [t for t in todos if t["done"]]
        if not done:
            print("没有已完成的任务")
            return
        arch = load_todos_file(ARCHIVE)
        arch.extend(done)
        save_todos_file(ARCHIVE, arch)
        save_todos([t for t in todos if not t["done"]])
        print("已归档 %d 条" % len(done))
        return

    if cmd == "arch":
        sub = a[1] if len(a) > 1 else "list"
        arch = load_todos_file(ARCHIVE)
        if sub == "list":
            if not arch:
                print("(归档是空的)")
            for i, it in enumerate(arch, 1):
                due = it["due"] or "-"
                print("%2d  %-28s 截止:%s" % (i, it["text"], due))
            return
        if sub == "restore":
            i = int(a[2]) - 1
            if not (0 <= i < len(arch)):
                print("序号越界")
                sys.exit(2)
            it = arch.pop(i)
            todos = load_todos()
            it["done"] = False
            todos.append(it)
            save_todos(todos)
            save_todos_file(ARCHIVE, arch)
            print("已恢复：" + it["text"])
            return
        print("未知子命令: " + sub)
        sys.exit(2)

    if cmd == "ev":
        sub = a[1] if len(a) > 1 else "list"
        evs = load_events()
        if sub == "list":
            if not evs:
                print("(没有安排)")
            for i, e in enumerate(evs, 1):
                print("%2d %s %s-%s [%s] {分类:%s} %s" % (i, e["date"], e["start"], e["end"], e["kind"], e["cat"], e["name"]))
            return
        if sub == "add":
            if len(a) < 7:
                print('用法: ev add 2026-11-21 14:00 15:00 会议 选题讨论 [日常|特殊|重要]')
                sys.exit(2)
            cat = norm_cat(a[7]) if len(a) > 7 else "日常"
            evs.append({"date": a[2], "start": a[3], "end": a[4], "kind": a[5], "name": a[6], "cat": cat})
            save_events(evs)
            print("已加安排：" + a[6] + "（" + cat + "）")
            return
        if sub == "cat":
            if len(a) < 4:
                print('用法: ev cat 2 重要   （分类只能是 日常 / 特殊 / 重要）')
                sys.exit(2)
            i = int(a[2]) - 1
            if not (0 <= i < len(evs)):
                print("序号越界")
                sys.exit(2)
            cat = norm_cat(a[3])
            evs[i]["cat"] = cat
            save_events(evs)
            print("已改为「%s」：%s" % (cat, evs[i]["name"]))
            return
        if sub == "del":
            i = int(a[2]) - 1
            if not (0 <= i < len(evs)):
                print("序号越界")
                sys.exit(2)
            t = evs.pop(i)
            save_events(evs)
            print("已删安排：" + t["name"])
            return
        print("未知子命令: " + sub)
        sys.exit(2)

    if cmd == "cls":
        sub = a[1] if len(a) > 1 else "list"
        cls = load_classes()
        if sub == "list":
            if not cls:
                print("(课表空)")
            for i, c in enumerate(cls, 1):
                print("%2d %s %s-%s %s" % (i, WD[c["day"] - 1], c["start"], c["end"], c["name"]))
            return
        if sub == "add":
            if len(a) < 6:
                print('用法: cls add 3 08:00 09:40 生物化学')
                sys.exit(2)
            cls.append({"day": int(a[2]), "start": a[3], "end": a[4], "name": a[5]})
            cls.sort(key=lambda c: (c["day"], c["start"]))
            save_classes(cls)
            print("已加课：" + a[5])
            return
        if sub == "del":
            i = int(a[2]) - 1
            if not (0 <= i < len(cls)):
                print("序号越界")
                sys.exit(2)
            t = cls.pop(i)
            save_classes(cls)
            print("已删课：" + t["name"])
            return
        print("未知子命令: " + sub)
        sys.exit(2)

    print("未知命令: " + cmd)
    sys.exit(2)


if __name__ == "__main__":
    main()
