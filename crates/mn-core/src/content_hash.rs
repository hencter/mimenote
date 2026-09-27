//! # 内容哈希（M5 二级令牌）
//!
//! 跨会话增量复用的判定键是 `(path, mtime_ms, size)`（见 `mn-index` 的 `notes_meta`）：
//! 打开 Vault 时对得上就**一个文件都不读**（30× 加速）。代价是漏检窗口 ——
//! **同一毫秒内、字节数又完全相同**的内容改动会被判成"没变"（与 ADR-0004 的冲突检测同一取舍）。
//!
//! 本模块提供二级令牌：文本内容的 64 位 FNV-1a 哈希。选择它的理由：
//!
//! * **零新依赖**：`std` 即可实现，哈希值跨版本稳定（与 `DefaultHasher` 不同，
//!   后者明确不保证稳定性，用它做落盘判定键下次升级就全员失效）；
//! * **缓存用途**：索引是可重建的派生数据（ADR-0002），哈希碰撞的最坏结果是"这次没发现改动"，
//!   下一次 mtime 变化仍会重建 —— 不做安全边界，只做漏检收窄；
//! * **写入时免费**：索引构建与保存路径手上本来就有全文，算一次哈希是 O(文本) 的内存遍历，
//!   相对分词/落盘可忽略；**打开时的复用快路径仍然不读文件**（否则 30× 加速就没了），
//!   哈希只在"手上已经有文本"的地方做比对（读笔记时顺手校验、写入时落盘）。
//!
//! 同一毫秒漏检的剩余窗口（打开时复用快路径仍然信任元数据）见 `mn-index` 的文档与 ADR-0008「后续修订」。

/// FNV-1a 64 的偏移基数。
const FNV_OFFSET_BASIS: u64 = 14695981039346656037;
/// FNV-1a 64 的素数。
const FNV_PRIME: u64 = 1099511628211;

/// 文本内容的 64 位哈希（FNV-1a，`UTF-8` 字节流）。
///
/// 空字符串也有确定值（偏移基数本身），因此"空笔记"与"没有这篇"是可区分的。
pub fn content_hash(text: &str) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_hash_is_the_offset_basis() {
        assert_eq!(content_hash(""), FNV_OFFSET_BASIS);
    }

    #[test]
    fn known_vector_matches_fnv1a64() {
        // FNV-1a 64 的公开测试向量：`foobar` → `0x85944171f73967e8`。
        assert_eq!(content_hash("foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn single_char_change_flips_the_hash() {
        // 同字节数、只差一个汉字的两份正文（正是二级令牌要抓的形态）必须不等。
        let before = "甲乙丙丁";
        let after = "甲乙丙戊";
        assert_eq!(before.len(), after.len());
        assert_ne!(content_hash(before), content_hash(after));
    }

    #[test]
    fn hash_is_stable_across_calls() {
        let text = "见 [[乙]] 与 #标签\n\n第二行正文。\n";
        assert_eq!(content_hash(text), content_hash(text));
    }
}
