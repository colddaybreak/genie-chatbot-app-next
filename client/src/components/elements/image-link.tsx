import type { AnchorHTMLAttributes, ComponentType } from 'react';
import { DatabricksMessageCitationStreamdownIntegration } from '../databricks-message-citation';

/**
 * 匹配以常见图片扩展名结尾的 URL（允许带 ?query 或 #hash 后缀）。
 * 如果你们的图片链接还有其他扩展名，往这个正则里加即可。
 */
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i;

export const isImageUrl = (url?: string): boolean =>
  typeof url === 'string' && IMAGE_URL_RE.test(url);

/**
 * Streamdown 自定义 <a> 渲染器：
 * 1. 表格单元格里的裸图片 URL 会被 GFM 自动转成 <a> 链接，
 *    这里识别出指向图片的链接，直接渲染成图片，点击在新标签页打开原地址；
 * 2. 其他链接走原有的 Databricks 引用 / 默认链接逻辑，行为不变。
 */
export const ImageLinkAnchor: ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement>
> = ({ node: _node, ...props }) => {
  if (isImageUrl(props.href)) {
    return (
      <a
        href={props.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block max-w-full align-middle"
        title={props.href}
      >
        <img
          src={props.href}
          alt={typeof props.children === 'string' ? props.children : 'image'}
          loading="lazy"
          className="max-h-40 max-w-[240px] rounded-md border border-border object-contain"
        />
      </a>
    );
  }
  return <DatabricksMessageCitationStreamdownIntegration {...props} />;
};