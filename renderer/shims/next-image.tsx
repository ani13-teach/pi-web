/**
 * `next/image` replacement: the only usage is a small logo, so a plain <img>
 * with the same props is equivalent (no Next image optimizer exists here).
 */
import { forwardRef, type ImgHTMLAttributes } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  width?: number | string;
  height?: number | string;
  priority?: boolean;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
  unoptimized?: boolean;
};

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  { src, width, height, priority: _priority, quality: _quality, placeholder: _placeholder, blurDataURL: _blur, unoptimized: _unoptimized, ...rest },
  ref,
) {
  return <img ref={ref} src={src} width={width} height={height} {...rest} />;
});

export default Image;
