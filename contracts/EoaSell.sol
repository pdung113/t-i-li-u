// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice Bytecode này chỉ được gắn tạm vào ví lúc mô phỏng (state override).
/// Không deploy on-chain. Chạy trong ngữ cảnh ví: address(this) là ví mua.
contract EoaSell {
    function sell(address router, address weth, address token)
        external
        returns (uint256 expectedSell, uint256 gotEth, uint256 sold)
    {
        sold = IERC20(token).balanceOf(address(this));
        if (sold == 0) return (0, 0, 0);

        (bool approved,) = token.call(abi.encodeWithSelector(0x095ea7b3, router, type(uint256).max));
        approved;

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = weth;

        try IRouter(router).getAmountsOut(sold, path) returns (uint256[] memory amounts) {
            expectedSell = amounts[amounts.length - 1];
        } catch {}

        uint256 beforeEth = address(this).balance;
        IRouter(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            sold, 0, path, address(this), block.timestamp + 3600
        );
        gotEth = address(this).balance - beforeEth;
    }

    receive() external payable {}
}
